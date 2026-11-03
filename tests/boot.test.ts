import { describe, expect, it } from "vitest";

import { boot_probe, efi_entries, grub_entries, grub_menu_entries, systemd_boot_entries } from "../src/agent/operations/boot.ts";
import type { Context, ProgramResult } from "../src/agent/programs.ts";
import { next_boot_operation, parse_boot } from "../src/server/nixos/boot.ts";
import type { Boot } from "../src/shared/facts.ts";
import type { Operation } from "../src/shared/operations.ts";
import { make_host, result, type HostHarness as Harness } from "./fake_agent.ts";

const bootctl = JSON.stringify([
  { type: "type1", id: "nixos-generation-101.conf", title: "NixOS", showTitle: "NixOS (Generation 101)", isDefault: true, isSelected: true },
  { type: "type1", id: "nixos-generation-100.conf", title: "NixOS", showTitle: "NixOS (Generation 100)", isDefault: false },
  { type: "loader", id: "auto-reboot-to-firmware-setup", title: "Reboot Into Firmware Interface" },
]);

const grub_cfg = `set default="\${saved_entry}"
function load_video {
  insmod all_video
}
menuentry 'Ubuntu' --class ubuntu $menuentry_id_option 'gnulinux-simple' {
	recordfail
	linux /vmlinuz root=UUID=x ro
}
submenu 'Advanced options for Ubuntu' $menuentry_id_option 'gnulinux-advanced' {
	menuentry 'Ubuntu, with Linux 6.8.0' --class ubuntu {
		linux /vmlinuz-6.8.0
	}
	menuentry "Ubuntu, with Linux 6.8.0 (recovery mode)" {
		linux /vmlinuz-6.8.0 single
	}
}
menuentry 'Windows Boot Manager (on /dev/sda1)' --class windows {
	chainloader /EFI/Microsoft/Boot/bootmgfw.efi
}
`;

const efibootmgr = `BootCurrent: 0001
Timeout: 1 seconds
BootNext: 0003
BootOrder: 0001,0003,0000
Boot0000* EFI PXE 0 for IPv4\tPciRoot(0x0)/Pci(0x1c,0x0)
Boot0001* Linux Boot Manager\tHD(1,GPT,x)/File(\\EFI\\systemd\\systemd-bootx64.efi)
Boot0003* Windows Boot Manager\tHD(1,GPT,x)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)
`;

// The boot a read answers, from a loader's entries and its one-shot next entry.
function boot_of(loader: Boot["loader"], [entries, next]: [Omit<Boot["entries"][number], "next">[], string | null], reboot_tool?: string): Boot {
  const boot: Boot = {
    loader, entries: entries.map((entry) => ({ ...entry, next: entry.id === next })), default: entries.find((entry) => entry.default)?.id ?? null, next,
  };
  return reboot_tool === undefined ? boot : { ...boot, reboot_tool };
}

function systemd_boot(oneshot: string | null = null): string {
  return JSON.stringify(boot_of("systemd-boot", [systemd_boot_entries(bootctl), oneshot]));
}

const grub_boot = boot_of("grub", grub_entries("", grub_cfg), "grub2-reboot");
const efi_boot = boot_of("efi", efi_entries(efibootmgr));

// The programs a next boot operation runs, one argument list each.
function argv_of(operation: Operation): string[][] {
  return operation.kind === "programs" ? operation.steps.map((step) => step.argv) : [];
}

// A context whose programs answer from a table, recording each one asked for.
function fake_context(answers: Record<string, ProgramResult>, asked: string[][]): { context: Context; output: () => string } {
  let output = "";
  const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
  const context: Context = {
    out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: false, stdin: null,
    program: async (_context, argv) => {
      asked.push(argv);
      return answers[argv.join(" ")] ?? { exit_code: 1, stdout: "", stderr: "not here" };
    },
  };
  return { context, output: () => output };
}

// A deployment that has read these boot entries.
async function read(output = systemd_boot(), values: Record<string, unknown> = {}): Promise<Harness> {
  const harness = make_host(values);
  harness.agent.boot_probe_result = result(0, output);
  await harness.host.cycle();
  return harness;
}

// ── Reading ──────────────────────────────────────────────────────────────────

describe("parsing", () => {
  it("reads systemd-boot's entries and default", () => {
    const entries = systemd_boot_entries(bootctl);
    expect(entries.find((entry) => entry.id === "nixos-generation-100.conf")?.title).toBe("NixOS (Generation 100)");
    expect(entries.filter((entry) => entry.default).map((entry) => entry.id)).toEqual(["nixos-generation-101.conf"]);
  });

  it("reads no entries from unreadable bootctl output", () => {
    expect(systemd_boot_entries("not json")).toEqual([]);
  });

  it("names GRUB's entries as grub-reboot does, following submenus", () => {
    expect(grub_menu_entries(grub_cfg)).toEqual([
      "Ubuntu",
      "Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0",
      "Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0 (recovery mode)",
      "Windows Boot Manager (on /dev/sda1)",
    ]);
  });

  it("reads GRUB's saved and next entry, by title or number, else the first", () => {
    const [named, next] = grub_entries("# GRUB Environment Block\nsaved_entry=Windows Boot Manager (on /dev/sda1)\nnext_entry=Ubuntu\n", grub_cfg);
    expect([named.find((entry) => entry.default)?.id, next]).toEqual(["Windows Boot Manager (on /dev/sda1)", "Ubuntu"]);

    const [numbered, none] = grub_entries("saved_entry=3\n", grub_cfg);
    expect([numbered.find((entry) => entry.default)?.id, none]).toEqual(["Windows Boot Manager (on /dev/sda1)", null]);

    expect(grub_entries("", grub_cfg)[0].find((entry) => entry.default)?.id).toBe("Ubuntu");
  });

  it("reads efibootmgr's entries, boot order and BootNext", () => {
    const [entries, next] = efi_entries(efibootmgr);
    expect(entries.map((entry) => [entry.id, entry.title])).toEqual([["0000", "EFI PXE 0 for IPv4"], ["0001", "Linux Boot Manager"], ["0003", "Windows Boot Manager"]]);
    expect([entries.find((entry) => entry.default)?.id, next]).toEqual(["0001", "0003"]);
  });

  it("reads the server's JSON, and nothing from a read that printed none", () => {
    expect(parse_boot(systemd_boot("nixos-generation-100.conf"))).toMatchObject({ loader: "systemd-boot", default: "nixos-generation-101.conf", next: "nixos-generation-100.conf" });
    expect(parse_boot("")).toBeNull();
    expect(parse_boot("loader=none")).toBeNull();
  });
});

describe("the read", () => {
  it("tries sudo, then falls back to reading unprivileged", async () => {
    const asked: string[][] = [];
    const { context, output } = fake_context({ "bootctl list --json=short": { exit_code: 0, stdout: bootctl, stderr: "" } }, asked);
    expect(await boot_probe(context, { kind: "boot_probe", require_sudo: true })).toBe(0);
    expect(asked.slice(0, 2)).toEqual([["sudo", "-n", "bootctl", "list", "--json=short"], ["bootctl", "list", "--json=short"]]);
    expect(JSON.parse(output())).toMatchObject({ loader: "systemd-boot", default: "nixos-generation-101.conf" });
  });

  it("asks bootctl without sudo when require_sudo is off", async () => {
    const asked: string[][] = [];
    const { context, output } = fake_context({ "bootctl list --json=short": { exit_code: 0, stdout: bootctl, stderr: "" } }, asked);
    await boot_probe(context, { kind: "boot_probe", require_sudo: false });
    expect(asked.flat()).not.toContain("sudo");
    expect(JSON.parse(output()).entries).toHaveLength(3);
  });

  it("keeps the entries a host last read when a read answers nothing", async () => {
    const harness = await read();
    harness.agent.boot_probe_result = result(-1, "", "timed out");
    await harness.host.cycle();
    expect(harness.host.reading()?.boot?.entries).toHaveLength(3);
  });

  it("is left alone with boot set to false", async () => {
    const harness = await read(systemd_boot(), { boot: false });
    expect(harness.host.reading()?.boot).toBeNull();
    expect(harness.agent.operations.some((operation) => operation.kind === "boot_probe")).toBe(false);
  });
});

// ── Next boot ────────────────────────────────────────────────────────────────

describe("next boot", () => {
  it("uses each loader's own one-shot tool, passing the entry as one argument", () => {
    expect(argv_of(next_boot_operation(parse_boot(systemd_boot())!, "nixos-generation-100.conf", false, true))).toEqual([["sudo", "-n", "bootctl", "set-oneshot", "nixos-generation-100.conf"]]);
    expect(argv_of(next_boot_operation(grub_boot, "Windows Boot Manager (on /dev/sda1)", false, true))).toEqual([["sudo", "-n", "grub2-reboot", "Windows Boot Manager (on /dev/sda1)"]]);
    expect(argv_of(next_boot_operation(efi_boot, "0003", false, false))).toEqual([["efibootmgr", "--bootnext", "0003"]]);
  });

  it("reboots after, when asked", () => {
    expect(argv_of(next_boot_operation(parse_boot(systemd_boot())!, "nixos-generation-100.conf", true, true)))
      .toEqual([["sudo", "-n", "bootctl", "set-oneshot", "nixos-generation-100.conf"], ["sudo", "-n", "systemctl", "reboot"]]);
  });

  it("is set on the host, kept in the history and shown at once", async () => {
    const harness = await read();
    const outcome = await harness.host.set_next_boot("nixos-generation-100.conf", false);
    expect(outcome).toMatchObject({ ok: true, message: "Next boot set to NixOS (Generation 100)" });
    expect(harness.agent.operations.flatMap(argv_of)).toContainEqual(["sudo", "-n", "bootctl", "set-oneshot", "nixos-generation-100.conf"]);
    expect(harness.store.jobs()[0]).toMatchObject({ kind: "next-boot", state: "succeeded" });
    expect(harness.host.reading()?.boot?.next).toBe("nixos-generation-100.conf");
  });

  it("refuses an unknown entry and a host not read yet", async () => {
    const harness = await read();
    expect((await harness.host.set_next_boot("other", false)).message).toContain("not one of the host's boot entries");
    expect((await make_host().host.set_next_boot("nixos-generation-100.conf", false)).message).toContain("No boot loader");
  });

  it("keeps a failure's output", async () => {
    const harness = await read();
    harness.agent.command_result = result(1, "", "sudo: a password is required");
    const outcome = await harness.host.set_next_boot("nixos-generation-100.conf", true);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("password is required");
    expect(harness.host.reading()?.boot?.next).toBeNull();
  });
});
