// The Options pages: every deployment's option lists as a card, and one deployment's search over the NixOS and Home
// Manager options and packages of its own nixpkgs pin, with a form that commits simple options to the flake.

import {
  api, type ActionOutcome, type CatalogView, type OptionSource, type OptionView, type PackageEntry, type SearchAnswer, type SettingValue, type SettingsView,
} from "../api.ts";
import { age, h, stamp, type Child } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { crumbs, data_table, empty, facts, load, section, toast } from "../ui.ts";
import { refresh_interval_in_milliseconds, short_revision, type View } from "./shared.ts";

type Tab = OptionSource | "packages";

const tab_labels: Record<Tab, string> = { nixos: "NixOS options", "home-manager": "Home Manager options", packages: "Packages" };

// ── List ─────────────────────────────────────────────────────────────────────

export function options_list_view(): View {
  const list = h("div");
  const refresh = (quiet: boolean) => load(list, async () => {
    const catalogs = await api<CatalogView[]>("/api/options");
    if (catalogs.length === 0) return empty("No deployments yet.", "Name each NixOS host and its flake under deployments in the config file.");
    return h("div", { class: "grid" }, ...catalogs.map(catalog_card));
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Options",
    root: h("div", { class: "page" },
      h("h1", {}, "Options"),
      h("p", { class: "muted" }, "Search each deployment's NixOS options, Home Manager options and packages, from its own nixpkgs pin."),
      list,
    ),
    dispose: () => clearInterval(timer),
  };
}

function catalog_card(catalog: CatalogView): HTMLElement {
  const info = catalog.info;
  return h("a", { class: `card tone-edge-${info === null ? "none" : "good"}`, href: link(["options", catalog.id]) },
    h("div", { class: "card-head" }, h("strong", {}, catalog.name)),
    h("div", { class: "muted card-host" }, catalog.host ?? "this server"),
    h("dl", {},
      h("dt", {}, "Options"), h("dd", {}, info === null ? "—" : info.counts.nixos + info.counts.home_manager),
      h("dt", {}, "Packages"), h("dd", {}, info === null ? "—" : info.counts.packages),
      h("dt", {}, "Generated"), h("dd", {}, catalog.running_job ? "generating now" : info === null ? "never" : age(info.generated_epoch)),
    ));
}

// ── One deployment ───────────────────────────────────────────────────────────

export function options_view(id: string): View {
  const route = current_route();
  let tab: Tab = (["nixos", "home-manager", "packages"] as Tab[]).find((candidate) => candidate === route.query.get("source")) ?? "nixos";
  let settings: SettingsView | null = null;
  const base = `/api/deployments/${encodeURIComponent(id)}`;
  const heading = h("h1", {}, id);
  const status = h("div");
  const settings_panel = h("div");
  const results = h("div");
  const generate_button = h("button", { class: "accent solid", onclick: () => void run_generate() }, "Generate lists");
  const query = h("input", { type: "search", class: "filter", placeholder: "Search by name or description", "aria-label": "Search", value: route.query.get("query") ?? "" });
  const tabs = h("div", { class: "segmented", role: "group", "aria-label": "What to search" });

  const show_tabs = () => tabs.replaceChildren(...(Object.keys(tab_labels) as Tab[]).map((candidate) => h("button", {
    "aria-pressed": String(candidate === tab),
    onclick: () => {
      tab = candidate;
      replace_query({ source: tab === "nixos" ? null : tab });
      show_tabs();
      void search();
    },
  }, tab_labels[candidate])));

  // ── Status ────────────────────────────────────────────────────────────

  const show_status = (catalog: CatalogView): Child => {
    heading.textContent = catalog.name;
    const info = catalog.info;
    const job = catalog.running_job;
    generate_button.disabled = job !== null;
    const running = job && h("p", {}, "Generating the lists now: ", h("a", { href: link(["jobs", String(job.id)]) }, job.progress ?? "follow the job"));
    if (info === null) return [running, empty("No lists generated yet.", "Generate lists builds the options and searches the packages of this deployment's nixpkgs on its evaluating host.")];
    return [running, facts([
      ["Generated", h("span", { title: stamp(info.generated_epoch) }, age(info.generated_epoch))],
      ["nixpkgs", info.revision ? short_revision(info.revision) : h("code", {}, info.nixpkgs)],
      ["NixOS options", info.counts.nixos],
      ["Home Manager options", info.counts.home_manager || "none"],
      ["Packages", info.counts.packages],
    ]), info.errors.length > 0 && h("p", { class: "tone-warn" }, info.errors.join("; "))];
  };

  const refresh_status = (quiet: boolean) => load(status, async () => show_status(await api<CatalogView>(`${base}/options?limit=1`)), { quiet });

  // ── Settings ──────────────────────────────────────────────────────────

  const refresh_settings = () => load(settings_panel, async () => {
    settings = await api<SettingsView>(`${base}/settings`);
    const rows: [string, Child][] = [["File", settings.file ? h("code", {}, settings.file) : "—"]];
    if (settings.refusal) rows.push(["Form", h("span", { class: "tone-warn" }, settings.refusal)]);
    if (settings.error) rows.push(["Error", h("span", { class: "tone-bad" }, settings.error)]);
    if (settings.import_line) rows.push(["Import once", h("code", {}, settings.import_line)]);
    const values = Object.entries(settings.values);
    return [
      facts(rows, "rows"),
      values.length === 0
        ? empty("X-Nix sets no options here yet.", "Open an option below and commit a value; it lands in this file as one commit.")
        : data_table<[string, SettingValue]>([
          { label: "Option", cell: ([name]) => h("code", {}, name) },
          { label: "Value", cell: ([, value]) => h("code", {}, JSON.stringify(value)) },
          { label: "Actions", cell: ([name]) => h("div", { class: "row-actions" }, h("button", { class: "danger", onclick: () => void commit(name, null) }, "Unset")) },
        ], values, "Options X-Nix sets"),
    ];
  });

  const commit = async (name: string, value: SettingValue | null) => {
    try {
      const outcome = await api<ActionOutcome>(`${base}/settings`, "POST", { name, value });
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "See the commit" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh_settings();
  };

  // ── Search ────────────────────────────────────────────────────────────

  const search = () => load(results, async () => {
    const text = encodeURIComponent(query.value);
    if (tab === "packages") {
      const answer = await api<SearchAnswer<PackageEntry>>(`${base}/packages?query=${text}`);
      if (answer.entries.length === 0) return empty(answer.info === null ? "No lists generated yet." : "No package matches.");
      return [h("p", { class: "muted small" }, `${answer.total} found`), data_table<PackageEntry>([
        { label: "Attribute", cell: (entry) => h("code", {}, entry.attribute) },
        { label: "Version", cell: (entry) => entry.version || "—" },
        { label: "Description", cell: (entry) => entry.description },
      ], answer.entries, "Packages")];
    }
    const answer = await api<SearchAnswer<OptionView>>(`${base}/options?source=${tab}&query=${text}`);
    if (answer.entries.length === 0) return empty(answer.info === null ? "No lists generated yet." : "No option matches.");
    return [h("p", { class: "muted small" }, `${answer.total} found${answer.total > answer.entries.length ? `, showing the first ${answer.entries.length}` : ""}`),
      h("div", { class: "option-results" }, ...answer.entries.map(option_result))];
  });

  let search_timer: number | undefined;
  query.addEventListener("input", () => {
    replace_query({ query: query.value });
    clearTimeout(search_timer);
    search_timer = window.setTimeout(() => void search(), 250);
  });

  const option_result = (option: OptionView): HTMLElement => {
    const set_value = settings?.values[option.name];
    const value_output = h("div");
    const show_value = async () => {
      value_output.replaceChildren(h("span", { class: "muted" }, "Evaluating…"));
      try {
        const answer = await api<{ value: string | null; error: string | null }>(`${base}/options/value?name=${encodeURIComponent(option.name)}`);
        value_output.replaceChildren(answer.error ? h("pre", { class: "output tone-bad" }, answer.error) : h("pre", { class: "output" }, answer.value ?? ""));
      } catch (error) {
        value_output.replaceChildren(h("p", { class: "tone-bad" }, (error as Error).message));
      }
    };
    return h("details", { class: "form-group option-result" },
      h("summary", {}, h("code", {}, option.name), h("span", { class: "muted small" }, option.type),
        set_value !== undefined && h("span", { class: "badge tone-info" }, `X-Nix sets ${JSON.stringify(set_value)}`)),
      option.description && h("p", { class: "option-description" }, option.description),
      facts([
        ["Type", option.type],
        ["Default", option.default === null ? "—" : h("code", {}, option.default)],
        ["Example", option.example === null ? "—" : h("code", {}, option.example)],
        ["Declared in", option.declared_in.length === 0 ? "—" : h("ul", { class: "paths" }, ...option.declared_in.map((place) => h("li", { class: "path" }, h("code", {}, place))))],
        ...(option.read_only ? [["Read-only", "yes"] as [string, Child]] : []),
      ], "rows"),
      option.source === "nixos" && h("div", { class: "option-form" }, h("button", { onclick: () => void show_value() }, "Show current value"), value_output),
      option_form(option, set_value),
    );
  };

  const option_form = (option: OptionView, set_value: SettingValue | undefined): Child => {
    if (option.form === null) return null;
    if (settings?.refusal) return h("p", { class: "muted small" }, settings.refusal);
    const form = option.form;
    let input: HTMLInputElement | HTMLSelectElement;
    if (form.kind === "boolean" || form.kind === "enum") {
      const choices = form.kind === "boolean" ? ["true", "false"] : form.choices;
      const chosen = set_value === undefined ? null : String(set_value);
      input = h("select", { "aria-label": `Value of ${option.name}` }, ...choices.map((choice) => h("option", { value: choice, selected: choice === chosen }, choice)));
    } else {
      input = h("input", {
        type: form.kind === "integer" ? "number" : "text", "aria-label": `Value of ${option.name}`, value: set_value === undefined ? "" : String(set_value),
        min: form.kind === "integer" ? form.minimum : null, max: form.kind === "integer" ? form.maximum : null, step: form.kind === "integer" ? 1 : null,
      });
    }
    const value_of = (): SettingValue => {
      if (form.kind === "boolean") return input.value === "true";
      if (form.kind === "integer") return Number(input.value);
      return input.value;
    };
    return h("form", { class: "option-form", onsubmit: (event: Event) => {
      event.preventDefault();
      void commit(option.name, value_of());
    } },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Set through X-Nix"), input),
      h("button", { type: "submit", class: "accent solid" }, "Commit"),
      set_value !== undefined && h("button", { type: "button", class: "danger", onclick: () => void commit(option.name, null) }, "Unset"));
  };

  const run_generate = async () => {
    generate_button.disabled = true;
    try {
      const outcome = await api<ActionOutcome>(`${base}/options/generate`, "POST");
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await refresh_status(true);
  };

  show_tabs();
  void refresh_status(false);
  // The form needs the file's values, so the search waits for them.
  void refresh_settings().then(() => search());
  const timer = setInterval(() => void refresh_status(true), refresh_interval_in_milliseconds);

  return {
    title: `Options · ${id}`,
    root: h("div", { class: "page" },
      crumbs([["Options", link(["options"])], [id, null]]),
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, heading), h("div", { class: "head-actions" }, generate_button)),
      section("Lists", status),
      section("Set by X-Nix", settings_panel),
      section("Search", results, [tabs, query]),
    ),
    dispose: () => {
      clearInterval(timer);
      clearTimeout(search_timer);
    },
  };
}
