import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { boot_script, grub_menu_entries, next_boot_command, parse_boot } from "../src/server/nixos/boot.ts";
import { make_deployment, result, type Harness } from "./fake_agent.ts";

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

function systemd_boot(oneshot = ""): string {
  return `loader=systemd-boot\noneshot=${oneshot}\n@@entries\n${bootctl}\n`;
}

// A deployment that has read these boot entries.
async function read(output = systemd_boot(), values: Record<string, unknown> = {}): Promise<Harness> {
  const harness = make_deployment(values);
  harness.agent.boot_probe_result = result(0, output);
  await harness.deployment.cycle();
  return harness;
}

// ── Reading ──────────────────────────────────────────────────────────────────

describe("parsing", () => {
  it("reads systemd-boot's default and one-shot entry", () => {
    const boot = parse_boot(systemd_boot("nixos-generation-100.conf"));
    expect(boot).toMatchObject({ loader: "systemd-boot", default: "nixos-generation-101.conf", next: "nixos-generation-100.conf" });
    expect(boot.entries.find((entry) => entry.id === "nixos-generation-100.conf")?.title).toBe("NixOS (Generation 100)");
    expect(boot.entries.filter((entry) => entry.next).map((entry) => entry.id)).toEqual(["nixos-generation-100.conf"]);
    expect(parse_boot(systemd_boot()).next).toBeNull();
  });

  it("reads no entries from unreadable bootctl output", () => {
    expect(parse_boot("loader=systemd-boot\noneshot=\n@@entries\nnot json\n")).toMatchObject({ entries: [], default: null });
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
    const named = parse_boot(`loader=grub\neditenv=grub-editenv\n@@env\n# GRUB Environment Block\nsaved_entry=Windows Boot Manager (on /dev/sda1)\nnext_entry=Ubuntu\n@@cfg\n${grub_cfg}`);
    expect(named).toMatchObject({ loader: "grub", default: "Windows Boot Manager (on /dev/sda1)", next: "Ubuntu", reboot_tool: "grub-reboot" });

    const numbered = parse_boot(`loader=grub\neditenv=grub2-editenv\n@@env\nsaved_entry=3\n@@cfg\n${grub_cfg}`);
    expect(numbered).toMatchObject({ default: "Windows Boot Manager (on /dev/sda1)", next: null, reboot_tool: "grub2-reboot" });

    expect(parse_boot(`loader=grub\neditenv=grub-editenv\n@@env\n@@cfg\n${grub_cfg}`).default).toBe("Ubuntu");
  });

  it("reads efibootmgr's entries, boot order and BootNext", () => {
    const boot = parse_boot(`loader=efi\n@@entries\n${efibootmgr}`);
    expect(boot.entries.map((entry) => [entry.id, entry.title])).toEqual([["0000", "EFI PXE 0 for IPv4"], ["0001", "Linux Boot Manager"], ["0003", "Windows Boot Manager"]]);
    expect([boot.default, boot.next]).toEqual(["0001", "0003"]);
  });

  it("reads nothing without a loader", () => {
    expect(parse_boot("loader=none")).toEqual({ loader: "none", entries: [], default: null, next: null });
  });
});

describe("the read", () => {
  it("tries sudo, then falls back to reading unprivileged", () => {
    expect(boot_script(true)).toContain("sudo -n bootctl list --json=short 2>/dev/null || bootctl list --json=short");
    expect(boot_script(false)).not.toContain("sudo");
    for (const require_sudo of [true, false]) expect(() => execFileSync("sh", ["-n", "-c", boot_script(require_sudo)])).not.toThrow();
  });

  it("reads systemd-boot through a fake bootctl", () => {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-boot-"));
    mkdirSync(join(folder, "bin"));
    writeFileSync(join(folder, "bin", "bootctl"), `#!/bin/sh\necho '${bootctl}'\n`);
    chmodSync(join(folder, "bin", "bootctl"), 0o755);
    const run = spawnSync("sh", ["-c", boot_script(false)], { encoding: "utf8", env: { ...process.env, PATH: `${join(folder, "bin")}:${process.env.PATH}` } });
    expect(parse_boot(run.stdout)).toMatchObject({ loader: "systemd-boot", default: "nixos-generation-101.conf" });
  });

  it("keeps the entries a deployment last read when a read answers nothing", async () => {
    const harness = await read();
    harness.agent.boot_probe_result = result(-1, "", "timed out");
    await harness.deployment.cycle();
    expect(harness.deployment.reading()?.boot?.entries).toHaveLength(3);
  });

  it("is left alone with boot set to false", async () => {
    const harness = await read(systemd_boot(), { boot: false });
    expect(harness.deployment.reading()?.boot).toBeNull();
    expect(harness.agent.commands.some((command) => command.includes("bootctl"))).toBe(false);
  });
});

// ── Next boot ────────────────────────────────────────────────────────────────

describe("next boot", () => {
  it("uses each loader's own one-shot tool, quoting the entry", () => {
    expect(next_boot_command(parse_boot(systemd_boot()), "nixos-generation-100.conf", false, true)).toBe("sudo -n bootctl set-oneshot nixos-generation-100.conf");
    const grub = parse_boot(`loader=grub\neditenv=grub2-editenv\n@@env\n@@cfg\n${grub_cfg}`);
    expect(next_boot_command(grub, "Windows Boot Manager (on /dev/sda1)", false, true)).toBe("sudo -n grub2-reboot 'Windows Boot Manager (on /dev/sda1)'");
    expect(next_boot_command(parse_boot(`loader=efi\n@@entries\n${efibootmgr}`), "0003", false, false)).toBe("efibootmgr --bootnext 0003");
  });

  it("reboots after, when asked", () => {
    expect(next_boot_command(parse_boot(systemd_boot()), "nixos-generation-100.conf", true, true))
      .toBe("sudo -n bootctl set-oneshot nixos-generation-100.conf && sudo -n systemctl reboot");
  });

  it("is set on the host, kept in the history and shown at once", async () => {
    const harness = await read();
    const outcome = await harness.deployment.set_next_boot("nixos-generation-100.conf", false);
    expect(outcome).toMatchObject({ ok: true, message: "Next boot set to NixOS (Generation 100)" });
    expect(harness.agent.commands).toContain("sudo -n bootctl set-oneshot nixos-generation-100.conf");
    expect(harness.store.jobs()[0]).toMatchObject({ kind: "next-boot", state: "succeeded" });
    expect(harness.deployment.reading()?.boot?.next).toBe("nixos-generation-100.conf");
  });

  it("refuses an unknown entry, a host not read yet, and a busy deployment", async () => {
    const harness = await read();
    expect((await harness.deployment.set_next_boot("other", false)).message).toContain("not one of the host's boot entries");
    expect((await make_deployment().deployment.set_next_boot("nixos-generation-100.conf", false)).message).toContain("No boot loader");
    await harness.deployment.act("switch");
    expect((await harness.deployment.set_next_boot("nixos-generation-100.conf", false)).message).toContain("already running");
  });

  it("keeps a failure's output", async () => {
    const harness = await read();
    harness.agent.command_result = result(1, "", "sudo: a password is required");
    const outcome = await harness.deployment.set_next_boot("nixos-generation-100.conf", true);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("password is required");
    expect(harness.deployment.reading()?.boot?.next).toBeNull();
  });
});
