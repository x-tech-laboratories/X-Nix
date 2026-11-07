// The Boot tab of a host's page: its boot entries, the entry it boots next, and Boot next and Reboot into.

import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Facts, Section, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { api, type ActionOutcome, type Boot, type BootEntry, type Host, type Job } from "../api.ts";
import { error_toast, JobsTable } from "./shared.tsx";

export const loader_names: Record<Boot["loader"], string> = { "systemd-boot": "systemd-boot", grub: "GRUB", efi: "EFI firmware", none: "None found" };

// ── Tab ──────────────────────────────────────────────────────────────────────

// The next boots set from here, or null when the host's boot entries are not read.
export async function load_boot(host: Host): Promise<Job[] | null> {
  if (!host.boot || !host.reading?.boot) return null;
  return api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(`host:${host.name}`)}&kind=next-boot&limit=10`);
}

export function BootTab({ host, jobs, refresh }: { host: Host; jobs: Job[] | null; refresh: () => void }) {
  const boot = host.reading?.boot ?? null;
  if (!host.boot) return <Empty title="Boot entries are not read." hint="Its host sets boot to false." />;
  if (boot === null || jobs === null) return <Empty title="No boot entries read." hint="They are read every cycle unless the host's boot is false." />;
  return <>
    <Tiles>
      <Tile label="Loader" value={loader_names[boot.loader]} />
      <Tile label="Default" value={title_of(boot, boot.default)} />
      <Tile label="Next boot" value={next_boot_text(boot)} class_name={boot.next ? "tile-info" : null} />
    </Tiles>
    <Section title="Details"><Facts layout="rows" rows={[["Booted system", host.system?.booted ? <code>{host.system.booted}</code> : "—"]]} /></Section>
    <Section title="Boot entries">
      {boot.entries.length === 0 ? <Empty title="No entries read." hint="Reading them may need sudo for bootctl." /> : <EntriesTable host={host} boot={boot} refresh={refresh} />}
    </Section>
    <Section title="Changes">{jobs.length === 0 ? <Empty title="No next boot set from here yet." /> : <JobsTable jobs={jobs} show_deployment={false} />}</Section>
  </>;
}

// ── Parts ────────────────────────────────────────────────────────────────────

function EntriesTable({ host, boot, refresh }: { host: Host; boot: Boot; refresh: () => void }) {
  const set_next = async (entry: BootEntry, reboot: boolean) => {
    try {
      const outcome = await api<ActionOutcome>(`/api/hosts/${encodeURIComponent(host.name)}/next-boot`, "POST", { entry: entry.id, reboot });
      toast(outcome.message, { tone: "good" });
    } catch (error) {
      error_toast(error);
    }
    refresh();
  };
  const refusal = host.next_boot_refusal;

  return (
    <DataTable<BootEntry> caption="Boot entries" rows={boot.entries} row_key={(entry) => entry.id} columns={[
      { label: "Entry", cell: (entry) => <span>{entry.title}{entry.title !== entry.id && <span className="muted small"> {entry.id}</span>}</span> },
      { label: "Default", cell: (entry) => (entry.default ? "Yes" : "") },
      { label: "Next", cell: (entry) => (entry.next ? "Once" : "") },
      { label: "Actions", cell: (entry) => (
        <div className="row-actions">
          <button disabled={refusal !== null || entry.next} title={refusal ?? undefined} onClick={() => void set_next(entry, false)}>Boot next</button>
          <button className="danger" disabled={refusal !== null} title={refusal ?? undefined} onClick={() => confirm_dialog({
            title: `Reboot ${host.display_name} into ${entry.title}`,
            message: `Reboot ${host.display_name} into ${entry.title} once? Everything running on it stops until it is back up, and the boot after returns to ${title_of(boot, boot.default)}.`,
            confirm_label: "Reboot",
            danger: true,
            run: () => set_next(entry, true),
          })}>Reboot into</button>
        </div>
      ) },
    ]} />
  );
}

// ── Wording ──────────────────────────────────────────────────────────────────

function title_of(boot: Boot, id: string | null): string {
  if (id === null) return "—";
  return boot.entries.find((entry) => entry.id === id)?.title ?? id;
}

function next_boot_text(boot: Boot | null): string {
  if (boot === null) return "—";
  return boot.next ? `${title_of(boot, boot.next)} (once)` : title_of(boot, boot.default);
}
