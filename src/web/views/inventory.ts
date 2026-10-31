// The Inventory page: every machine in the fleet's inventory file with its tags and roles, edited in place and saved
// as one commit to the flake.

import { api, type ActionOutcome, type InventoryView, type Job, type Machine } from "../api.ts";
import { h, type Child } from "../dom.ts";
import { link } from "../router.ts";
import { data_table, empty, facts, load, section, toast } from "../ui.ts";
import { jobs_table, type View } from "./shared.ts";

const consuming_example = `let
  inventory = builtins.fromJSON (builtins.readFile ./inventory.json);
  roles_of = name: inventory.machines.\${name}.roles or [ ];
in
nixpkgs.lib.nixosSystem {
  modules = [ ./hosts/odin ] ++ map (role: ./roles/\${role}.nix) (roles_of "odin");
}`;

// ── Page ─────────────────────────────────────────────────────────────────────

export function inventory_view(): View {
  const body = h("div", { class: "stack" });
  const save_button = h("button", { class: "accent solid", disabled: true, onclick: () => void save() }, "Save and commit");
  const reload_button = h("button", { onclick: () => void refresh() }, "Reload");
  let view: InventoryView | null = null;
  let machines: Machine[] = [];
  let changed = false;

  const mark_changed = () => {
    changed = true;
    save_button.disabled = false;
    render();
  };

  // A field that adds a word to a machine's list on Enter or its button.
  const adder = (label: string, add: (word: string) => void): HTMLElement => {
    const input = h("input", { type: "text", class: "inventory-add", placeholder: label, "aria-label": label });
    const commit = () => {
      const word = input.value.trim();
      if (word === "") return;
      if (!/^[A-Za-z0-9_.-]+$/.test(word)) {
        toast("Use letters, digits, ., - and _", "bad");
        return;
      }
      add(word);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });
    return h("span", { class: "inventory-adder" }, input, h("button", { onclick: commit, "aria-label": label }, "+"));
  };

  const word_list = (machine: Machine, field: "tags" | "roles"): Child => h("div", { class: "chips" },
    ...machine[field].map((word) => h("span", { class: "chip" }, word,
      h("button", { class: "link", "aria-label": `Remove ${word} from ${machine.name}`, onclick: () => {
        machine[field] = machine[field].filter((candidate) => candidate !== word);
        mark_changed();
      } }, "×"))),
    adder(field === "tags" ? "Add a tag" : "Add a role", (word) => {
      if (!machine[field].includes(word)) machine[field] = [...machine[field], word];
      mark_changed();
    }));

  const render = () => {
    if (view === null) return;
    if (!view.configured || view.refusal !== null || view.error !== null) {
      body.replaceChildren(empty(view.error ?? view.refusal ?? "No inventory is configured.", "Name the inventory's flake under inventory in the config file."));
      return;
    }
    const names = new Set(machines.map((machine) => machine.name));
    const suggestions = h("datalist", { id: "machine-suggestions" }, ...view.suggestions.filter((name) => !names.has(name)).map((name) => h("option", { value: name })));
    const new_machine = h("input", { type: "text", class: "inventory-add", placeholder: "Machine name", "aria-label": "New machine name", list: "machine-suggestions" });
    const add_machine = () => {
      const name = new_machine.value.trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return toast("Name the machine with letters, digits, - and _", "bad");
      if (names.has(name)) return toast(`${name} is already listed`, "bad");
      machines = [...machines, { name, tags: [], roles: [] }].sort((first, second) => first.name.localeCompare(second.name));
      mark_changed();
    };
    body.replaceChildren(
      section("Machines", [
        machines.length === 0 ? empty(view.present ? "No machines listed yet." : `${view.file} does not exist yet; saving creates it.`) : data_table<Machine>([
          { label: "Machine", cell: (machine) => h("strong", {}, machine.name) },
          { label: "Tags", cell: (machine) => word_list(machine, "tags") },
          { label: "Roles", cell: (machine) => word_list(machine, "roles") },
          { label: "Actions", cell: (machine) => h("div", { class: "row-actions" }, h("button", { class: "danger", onclick: () => {
            machines = machines.filter((candidate) => candidate !== machine);
            mark_changed();
          } }, "Remove")) },
        ], machines, "Machines"),
        h("div", { class: "option-form" }, new_machine, suggestions, h("button", { onclick: add_machine }, "Add machine")),
      ], changed ? h("span", { class: "badge tone-warn" }, "Unsaved changes") : null),
      section("File", facts([["Flake", h("code", {}, view.flake ?? "—")], ["File", h("code", {}, view.file ?? "—")]], "rows")),
      section("Using it in the flake", h("pre", { class: "output" }, consuming_example)),
      jobs_panel,
    );
  };

  const jobs_panel = h("div");
  const refresh_jobs = () => load(jobs_panel, async () => {
    const jobs = await api<Job[]>("/api/jobs?kind=inventory&limit=10");
    return section("Commits", jobs.length === 0 ? empty("Nothing committed from here yet.") : jobs_table(jobs, false));
  }, { quiet: true });

  const refresh = () => load(body, async () => {
    view = await api<InventoryView>("/api/inventory");
    machines = view.machines.map((machine) => ({ ...machine, tags: [...machine.tags], roles: [...machine.roles] }));
    changed = false;
    save_button.disabled = true;
    save_button.hidden = !view.configured;
    render();
    void refresh_jobs();
    return [...body.childNodes];
  });

  const save = async () => {
    if (view === null || view.hash === null) return;
    save_button.disabled = true;
    try {
      const outcome = await api<ActionOutcome>("/api/inventory", "POST", { machines, hash: view.hash });
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "See the commit" });
      await refresh();
    } catch (error) {
      toast((error as Error).message, "bad");
      save_button.disabled = false;
    }
  };

  void refresh();

  return {
    title: "Inventory",
    root: h("div", { class: "page" },
      h("header", { class: "page-head" }, h("div", { class: "card-head" }, h("h1", {}, "Inventory")), h("div", { class: "head-actions" }, reload_button, save_button)),
      h("p", { class: "muted" }, "The machines of the fleet with their tags and roles, kept in one file in the flake that its configurations read."),
      body,
    ),
  };
}
