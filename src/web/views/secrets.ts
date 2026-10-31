// The Secrets pages: every deployment that declares secrets as a card, and one deployment's secrets with whether each
// is on its host and current, and Upload. Only names, sizes, paths, owners and modes are ever shown.

import { api, type ActionOutcome, type Job, type KeyCondition, type SecretView, type SecretsView } from "../api.ts";
import { age, bytes, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { crumbs, data_table, empty, facts, load, section, toast } from "../ui.ts";
import { jobs_table, refresh_interval_in_milliseconds, tile, type View } from "./shared.ts";

const condition_labels: Record<KeyCondition, [text: string, tone: string]> = {
  current: ["Current", "good"], stale: ["Stale", "warn"], missing: ["Missing", "bad"], unknown: ["Unknown", "none"],
};

// ── List ─────────────────────────────────────────────────────────────────────

export function secrets_list_view(): View {
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const entries = await api<SecretsView[]>("/api/secrets");
    if (entries.length === 0) return empty("No secrets declared.", "List each key under a deployment's secrets in the config file, with its source file on this server.");
    return h("div", { class: "grid" }, ...entries.map(secrets_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Secrets",
    root: h("div", { class: "page" },
      h("h1", {}, "Secrets"),
      h("p", { class: "muted" }, "Keys uploaded to each host outside the Nix store, and whether each is there and current."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

function counts(entry: SecretsView): Record<KeyCondition, number> {
  const tally: Record<KeyCondition, number> = { current: 0, stale: 0, missing: 0, unknown: 0 };
  for (const secret of entry.reading?.secrets ?? []) tally[secret.on_host] += 1;
  return tally;
}

function secrets_card(entry: SecretsView): HTMLElement {
  const tally = counts(entry);
  const tone = tally.missing > 0 ? "bad" : tally.stale > 0 ? "warn" : entry.reading === null || tally.unknown > 0 ? "none" : "good";
  return h("a", { class: `card tone-edge-${tone}`, href: link(["secrets", entry.id]) },
    h("div", { class: "card-head" }, h("strong", {}, entry.name)),
    h("div", { class: "muted card-host" }, entry.host ?? "this server"),
    h("dl", {},
      h("dt", {}, "Secrets"), h("dd", {}, entry.count),
      h("dt", {}, "Current"), h("dd", {}, entry.reading === null ? "—" : tally.current),
      h("dt", {}, "Checked"), h("dd", {}, entry.reading === null ? "never" : age(entry.reading.checked_epoch)),
    ));
}

// ── One deployment ───────────────────────────────────────────────────────────

export function secrets_view(id: string): View {
  const body = h("div", { class: "stack" });
  const heading = h("h1", {}, id);
  const path = `/api/deployments/${encodeURIComponent(id)}/secrets`;
  const check_button = h("button", { onclick: () => void run_check() }, "Check now");
  const upload_button = h("button", { class: "accent solid", onclick: () => void run_upload() }, "Upload all");

  const render = (entry: SecretsView, jobs: Job[]) => {
    heading.textContent = entry.name;
    const reading = entry.reading;
    const tally = counts(entry);
    return [
      h("div", { class: "tiles" },
        tile("Secrets", String(entry.count)),
        tile("Current", reading === null ? "—" : String(tally.current)),
        tile("Missing or stale", reading === null ? "—" : String(tally.missing + tally.stale), tally.missing + tally.stale > 0 ? "tone-edge-warn" : null),
        tile("Checked", reading === null ? "never" : h("span", { title: stamp(reading.checked_epoch) }, age(reading.checked_epoch))),
      ),
      reading?.error ? h("p", { class: "tone-bad", role: "alert" }, `Could not read the host: ${reading.error}`) : null,
      section("Keys", reading === null ? empty("Not checked yet.") : keys_table(reading.secrets)),
      section("Uploads", jobs.length === 0 ? empty("Nothing uploaded yet.") : jobs_table(jobs, false)),
      section("Waiting for a key", facts([
        ["Unit", h("code", {}, "<name>-key.service")],
        ["Declared by", h("code", {}, "services.x-nix-agent.keys.<name>")],
        ["Use", "Give a service after and wants on the key's unit, so it starts once the key is on the host."],
      ], "rows")),
    ];
  };

  const refresh = (quiet: boolean) => load(body, async () => {
    const [entry, jobs] = await Promise.all([
      api<SecretsView>(path),
      api<Job[]>(`/api/jobs?deployment=${encodeURIComponent(id)}&kind=secrets&limit=10`),
    ]);
    return render(entry, jobs);
  }, { quiet });

  const run_check = async () => {
    check_button.disabled = true;
    await api(`${path}/check`, "POST").catch((error) => toast(String(error.message), "bad"));
    check_button.disabled = false;
    await refresh(true);
  };

  const run_upload = async () => {
    upload_button.disabled = true;
    try {
      const outcome = await api<ActionOutcome>(`${path}/upload`, "POST");
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "See the job" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    upload_button.disabled = false;
    await refresh(true);
  };

  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: `Secrets · ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Secrets", link(["secrets"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading), h("div", { class: "head-actions" }, check_button, upload_button)),
      body,
    ),
    dispose: () => clearInterval(timer),
  };
}

function keys_table(secrets: SecretView[]): HTMLElement {
  return data_table<SecretView>([
    { label: "Name", cell: (secret) => secret.name },
    { label: "Destination", cell: (secret) => h("code", {}, secret.destination) },
    { label: "Owner", cell: (secret) => `${secret.owner}:${secret.group} ${secret.mode}` },
    { label: "Source", cell: (secret) => secret.source_error === null
      ? h("span", { title: secret.source }, bytes(secret.source_size ?? 0))
      : h("span", { class: "tone-bad", title: secret.source }, `Unreadable: ${secret.source_error}`) },
    { label: "On host", cell: (secret) => {
      const [text, tone] = condition_labels[secret.on_host];
      return h("span", {}, h("span", { class: `badge tone-${tone}` }, text), secret.difference && h("span", { class: "muted small" }, ` ${secret.difference}`));
    } },
  ], secrets, "Keys");
}
