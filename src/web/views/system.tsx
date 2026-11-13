// The System tab of a host's page: the deployment it runs, with its drift, findings, pin, jobs, events and generations.

import { Badge, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { BarChart } from "@x-tech-laboratories/x-libs/web/react/charts";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Facts, Section, Stack, Tile, Tiles, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { age, bytes } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useState } from "react";
import { api, type ActionOutcome, type Deployment, type DiffOutcome, type EventRow, type Generation, type GenerationSize, type Job } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { DiffView, drift_state, error_toast, EventsList, FlakeLink, job_toast, JobsTable, MessagesList, TagChips } from "./shared.tsx";

// ── Tab ──────────────────────────────────────────────────────────────────────

export interface SystemData {
  jobs: Job[];
  events: EventRow[];
}

export async function load_system(deployment: Deployment): Promise<SystemData> {
  const id = encodeURIComponent(deployment.id);
  const [jobs, events] = await Promise.all([
    api<Job[]>(`/api/jobs?deployment=${id}&limit=10`),
    api<EventRow[]>(`/api/deployments/${id}/events`),
  ]);
  return { jobs, events };
}

export function SystemTab({ deployment, data, refresh }: { deployment: Deployment; data: SystemData; refresh: () => void }) {
  return <>
    <SystemTiles deployment={deployment} />
    <Section title="Findings"><MessagesList messages={deployment.reading?.messages ?? []} /></Section>
    <Section title="Details"><Details deployment={deployment} /></Section>
    <ChangesSection deployment={deployment} done={refresh} />
    <Section title="Pin"><PinForm deployment={deployment} done={refresh} /></Section>
    <Section title="Jobs">{data.jobs.length === 0 ? <Empty title="No jobs yet." /> : <JobsTable jobs={data.jobs} show_deployment={false} />}</Section>
    <Section title="Events">{data.events.length === 0 ? <Empty title="No events yet." /> : <EventsList events={data.events} />}</Section>
  </>;
}

// The generations, read from the host on demand rather than on every refresh of the page.
export function GenerationsSection({ deployment, refresh }: { deployment: Deployment; refresh: () => void }) {
  const generations = use_resource(async () => {
    const answer = await api<{ generations: Generation[] }>(`/api/deployments/${encodeURIComponent(deployment.id)}/generations`);
    return answer.generations;
  }, [deployment.id]);
  const done = () => {
    refresh();
    generations.reload(true);
  };
  return (
    <Section title="Generations" tools={<button onClick={() => generations.reload()}>Read again</button>}>
      <Stack>
        <Loaded resource={generations}>{(found) => <>
          <GenerationSizes deployment={deployment} generations={found} />
          <GenerationsTable deployment={deployment} generations={found} done={done} />
        </>}</Loaded>
      </Stack>
    </Section>
  );
}

// Each generation's closure size, oldest first, the running one in the accent; read after the list, as sizing takes longer.
function GenerationSizes({ deployment, generations }: { deployment: Deployment; generations: Generation[] }) {
  const sizes = use_resource(async () => {
    const answer = await api<{ sizes: GenerationSize[] }>(`/api/deployments/${encodeURIComponent(deployment.id)}/generations/sizes`);
    return answer.sizes;
  }, [deployment.id, generations.length]);
  const current = generations.find((generation) => generation.current)?.generation ?? null;
  return (
    <Loaded resource={sizes} lines={3}>
      {(found) => (
        <BarChart title="Closure size by generation" format={bytes} bars={[...found].reverse().map((size) => ({
          label: `Generation ${size.generation}`, value: size.closure_size_bytes, color: size.generation === current ? "var(--accent)" : "var(--series-3)",
        }))} />
      )}
    </Loaded>
  );
}

// ── Parts ────────────────────────────────────────────────────────────────────

// The system's state at a glance; what it is configured to do is under Details.
function SystemTiles({ deployment }: { deployment: Deployment }) {
  const reading = deployment.reading;
  const [drift, tone] = drift_state(deployment);
  return (
    <Tiles>
      <Tile label="Flake" value={drift} class_name={tone === "bad" ? "tile-bad" : null} />
      <Tile label="Reboot" value={reading?.reboot_required === true ? "Needed" : reading?.reboot_required === false ? "Not needed" : "—"} />
      <Tile label="Generation" value={String(reading?.generation ?? "—")} />
      <Tile label="Last switch" value={reading?.switched_epoch ? age(reading.switched_epoch) : "—"} />
      <Tile label="NixOS" value={reading?.version ?? "—"} />
    </Tiles>
  );
}

// The commit or tag the deployment is fixed at, and a form that pins it, follows the head, or goes back to the settings.
function PinForm({ deployment, done }: { deployment: Deployment; done: () => void }) {
  const [typed, set_typed] = useState(deployment.pin ?? "");
  // A new pin from the server, such as after Follow the branch head, shows in the field.
  useEffect(() => set_typed(deployment.pin ?? ""), [deployment.pin]);

  const send = async (body: { pin?: string | null; reset?: boolean }) => {
    try {
      toast((await api<ActionOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/pin`, "POST", body)).message, { tone: "good" });
    } catch (error) {
      error_toast(error);
    }
    done();
  };
  const where = deployment.pin_overridden ? "set here" : "from the settings";
  return (
    <Stack>
      <p>
        {deployment.pin === null
          ? `Following the branch head of ${deployment.flake} (${where}).`
          : <span>Evaluating, building and switching <code>{deployment.pin}</code>{` of ${deployment.flake} (${where}).`}</span>}
      </p>
      <form className="toolbar" onSubmit={(event) => {
        event.preventDefault();
        void send({ pin: typed.trim() === "" ? null : typed.trim() });
      }}>
        <label className="field">
          <span className="field-label">Commit or tag</span>
          <input type="text" className="filter" placeholder="commit hash or tag" aria-label="Pin" value={typed} onChange={(event) => set_typed(event.currentTarget.value)} />
        </label>
        <button type="submit" className="accent solid">Pin</button>
        <button type="button" disabled={deployment.pin === null} onClick={() => void send({ pin: null })}>Follow the branch head</button>
        {deployment.pin_overridden && (
          <button type="button" onClick={() => void send({ reset: true })}>
            {deployment.configured_pin === null ? "Use the settings (head)" : `Use the settings (${deployment.configured_pin})`}
          </button>
        )}
      </form>
    </Stack>
  );
}

function Details({ deployment }: { deployment: Deployment }) {
  const reading = deployment.reading;
  const evaluation = deployment.evaluation;
  const code = (text: string | null | undefined) => (text ? <code>{text}</code> : "—");
  const rows: Fact[] = [
    ["Deployment", deployment.name === deployment.id ? deployment.id : <span>{deployment.name} <code className="muted small">{deployment.id}</code></span>],
    ["Flake", <FlakeLink flake_id={deployment.flake_id} reference={deployment.flake} />],
    ["Configuration", deployment.configuration ?? reading?.hostname ?? "the host's own name"],
    ["Tags", deployment.tags.length === 0 ? "—" : <TagChips tags={deployment.tags} />],
    ["Running closure", code(reading?.current), "path"],
    ["Flake closure", code(evaluation.target), "path"],
  ];
  // A declared flake followed at its head shows its revision and inputs on its own page.
  if (deployment.flake_id === null || deployment.pin !== null) {
    rows.push(
      ["Flake revision", code(evaluation.flake_revision)],
      ["Flake last changed", <Age epoch={evaluation.flake_last_modified_epoch} />],
      ["Oldest input", <span>{evaluation.oldest_input ?? "—"} (<Age epoch={evaluation.inputs_last_modified_epoch} />)</span>],
    );
  }
  rows.push(
    ["Last evaluated", <span>
      {deployment.evaluating ? "evaluating now" : <Age epoch={evaluation.evaluated_epoch} />}
      {deployment.evaluated_by !== null && <> by the <a href={link(["cache", deployment.evaluated_by])}>{deployment.evaluated_by}</a> cache's check</>}
    </span>],
    ["Last read", <Age epoch={reading?.checked_epoch} />],
  );
  if (deployment.agents.eval !== deployment.host) rows.push(["Evaluates on", deployment.agents.eval ?? "this server"]);
  rows.push(["Builds on", `${deployment.agents.build ?? "this server"} now; ${direct_on_text[deployment.direct_on]}`]);
  if (deployment.agents.switch !== deployment.host) rows.push(["Switches from", deployment.agents.switch ?? "this server"]);
  const build_at = deployment.schedule.build;
  if (build_at !== null) rows.push(["Daily build", <span>at {build_at}, last slot <Age epoch={evaluation.scheduled.build} /></span>]);
  if (deployment.auto_switch) rows.push(["Automatic switch", "on"]);
  if (deployment.cache_id !== null) rows.push(["Built by", <a href={link(["cache", deployment.cache_id])}>the {deployment.cache_id} cache</a>]);
  rows.push(["Switch safety", safety_text(deployment)]);
  if (reading?.current) rows.push(["Closure browser", <a href={closure_link(deployment)}>Browse the running closure</a>]);
  if (evaluation.eval_error) rows.push(["Evaluation error", <pre className="output">{evaluation.eval_error}</pre>]);
  if (evaluation.metadata_error) rows.push(["Metadata error", <pre className="output">{evaluation.metadata_error}</pre>]);
  return <Facts rows={rows} layout="rows" />;
}

// What guards a switch, in one line.
// Where a build or switch builds, as direct_on says.
const direct_on_text: Record<Deployment["direct_on"], string> = {
  ranked: "the first connected host of its cache, else of its build agents",
  server: "this server",
  host: "the host itself",
};

function safety_text(deployment: Deployment): string {
  const safety = deployment.safety;
  const parts: string[] = [];
  if (safety.pre_switch_checks.length > 0) parts.push(`${safety.pre_switch_checks.length} pre-switch check${safety.pre_switch_checks.length === 1 ? "" : "s"}`);
  const health = safety.health_commands.length + safety.health_urls.length;
  if (health > 0) parts.push(`${health} health check${health === 1 ? "" : "s"} every ${safety.health_period}s for up to ${safety.health_timeout}s`);
  if (safety.magic_rollback) parts.push(`rolled back unless confirmed within ${safety.confirm_timeout}s of an activation that takes up to ${safety.activation_timeout}s`);
  if (safety.inhibit_sleep) parts.push("the host is kept awake while it switches");
  if (safety.close_nix_lock_holders) parts.push("what holds the Nix store database open is stopped once the activation waits a minute for it");
  return parts.length === 0 ? "none; the switch runs alone" : parts.join("; ");
}

// ── What a switch changes ────────────────────────────────────────────────────

// The last package diff, when it compares the running closure with the flake's current one.
function ChangesSection({ deployment, done }: { deployment: Deployment; done: () => void }) {
  const current = deployment.reading?.current ?? null;
  const target = deployment.evaluation.target;
  if (current === null || target === null || current === target) return null;
  const diff = deployment.evaluation.last_diff;
  const compare = async () => {
    toast("Comparing the running closure with the flake's…");
    try {
      const outcome = await api<DiffOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/diff`, "POST", { force: true });
      if (outcome.message !== null) toast(outcome.message);
    } catch (error) {
      error_toast(error);
    }
    done();
  };
  const fresh = diff !== null && diff.from === current && diff.to === target;
  return (
    <Section title="What a switch changes" tools={<button onClick={() => void compare()}>{fresh ? "Compare again" : "Compare now"}</button>}>
      {fresh ? <DiffView diff={diff} /> : <Empty title="Not compared yet." hint="Compare the running closure with the flake's, or a Build on the host compares them once it ends." />}
    </Section>
  );
}

// A link to the closure browser of the deployment's host.
function closure_link(deployment: Deployment, values: Record<string, number> = {}): string {
  return link(deployment.host_name === null ? ["deployments", deployment.id, "closure"] : ["hosts", deployment.host_name, "closure"], values);
}

// ── Generations ──────────────────────────────────────────────────────────────

function GenerationsTable({ deployment, generations, done }: { deployment: Deployment; generations: Generation[]; done: () => void }) {
  if (generations.length === 0) return <Empty title="No generations read." />;
  const roll_back = (generation: Generation) => confirm_dialog({
    title: `Roll back to generation ${generation.generation}`,
    message: `Activate generation ${generation.generation} and boot it from now on? The rollback is kept in the job history.`,
    confirm_label: "Roll back",
    danger: true,
    run: async () => {
      try {
        const outcome = await api<ActionOutcome>(`/api/deployments/${encodeURIComponent(deployment.id)}/rollback`, "POST", { generation: generation.generation });
        job_toast(outcome.message, outcome.job_id);
      } catch (error) {
        error_toast(error);
      }
      done();
    },
  });
  return (
    <DataTable<Generation> caption="Generations" rows={generations} row_key={(generation) => generation.generation} columns={[
      { label: "Generation", class: "number", cell: (generation) => String(generation.generation) },
      { label: "Created", cell: (generation) => (generation.created_epoch ? <Age epoch={generation.created_epoch} /> : "—") },
      { label: "Version", cell: (generation) => generation.version ?? "—" },
      { label: "State", cell: (generation) => (
        <Chips>
          {generation.current && <Badge tone="good">running</Badge>}
          {generation.booted && <Badge tone="info">booted</Badge>}
          {generation.profile && <Badge>default</Badge>}
        </Chips>
      ) },
      { label: "Actions", class: "actions-cell", cell: (generation) => (
        <span className="row-actions">
          <a className="button" href={closure_link(deployment, { generation: generation.generation })}>Closure</a>
          {!(generation.current && generation.profile) && <button className="danger" onClick={() => roll_back(generation)}>Roll back</button>}
        </span>
      ) },
    ]} />
  );
}
