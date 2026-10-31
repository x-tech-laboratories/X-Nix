// The Builds page: every finished build of a deployment or cache target with its result, duration, store path, log and
// products, filtered by deployment or cache and target.

import { api, type BuildRecord, type BuildsAnswer } from "../api.ts";
import { age, bytes, h, stamp } from "../dom.ts";
import { current_route, link } from "../router.ts";
import { data_table, empty, load, section } from "../ui.ts";
import { duration, refresh_interval_in_milliseconds, type View } from "./shared.ts";

// ── List ─────────────────────────────────────────────────────────────────────

export function builds_view(): View {
  const query = current_route().query;
  const owner = query.get("owner") ?? "";
  const target = query.get("target") ?? "";
  const filters = h("div", { class: "toolbar" });
  const list = h("div");

  const refresh = (quiet: boolean) => load(list, async () => {
    const search = new URLSearchParams({ limit: "200" });
    if (owner) search.set("owner", owner);
    if (target) search.set("target", target);
    const answer = await api<BuildsAnswer>(`/api/builds?${search}`);
    // The filters are drawn once, so a quiet refresh never takes a choice out from under the pointer.
    if (!quiet) filters.replaceChildren(...filter_fields(answer, owner, target));
    return answer.builds.length === 0
      ? empty("No builds yet.", "Each Build of a deployment, and each Build or Build all of a cache, shows here once it ends.")
      : builds_table(answer.builds);
  }, { quiet });
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Builds",
    root: h("div", { class: "page" },
      h("h1", {}, "Builds"),
      h("p", { class: "muted" }, "Every finished build, newest first, with its log and what it made. Products that are files inside their build's store path can be downloaded."),
      section("History", [filters, list]),
    ),
    dispose: () => clearInterval(timer),
  };
}

// The deployment or cache and target choices, each moving to the filtered page.
function filter_fields(answer: BuildsAnswer, owner: string, target: string): HTMLElement[] {
  const owners = [...new Set(answer.targets.map((entry) => entry.owner_id))];
  const targets = [...new Set(answer.targets.filter((entry) => !owner || entry.owner_id === owner).map((entry) => entry.target))];
  const choose = (values: Record<string, string | null>) => {
    location.hash = link(["builds"], { owner, target, ...values });
  };
  const options = (choices: string[], chosen: string, everything: string) => [
    h("option", { value: "", selected: chosen === "" }, everything),
    ...choices.map((choice) => h("option", { value: choice, selected: choice === chosen }, choice)),
  ];
  const owner_select = h("select", { onchange: () => choose({ owner: owner_select.value, target: null }) }, ...options(owners, owner, "Every deployment and cache"));
  const target_select = h("select", { onchange: () => choose({ target: target_select.value }) }, ...options(targets, target, "Every target"));
  return [
    h("label", { class: "field" }, h("span", { class: "field-label" }, "For"), owner_select),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Target"), target_select),
  ];
}

function builds_table(builds: BuildRecord[]): HTMLElement {
  return data_table<BuildRecord>([
    { label: "Build", cell: (build) => h("a", { href: link(["jobs", String(build.job_id)]), title: "Its log" }, `#${build.job_id}`) },
    { label: "For", cell: (build) => h("a", { href: link(["builds"], { owner: build.owner_id }) }, build.owner_id) },
    { label: "Target", cell: (build) => h("a", { href: link(["builds"], { owner: build.owner_id, target: build.target }) }, build.target) },
    { label: "Result", cell: (build) => h("span", { class: `badge tone-${build.succeeded ? "good" : "bad"}` }, build.succeeded ? "built" : "failed") },
    { label: "Finished", cell: (build) => h("span", { title: stamp(build.finished_epoch) }, age(build.finished_epoch)) },
    { label: "Took", cell: (build) => duration(Math.max(0, build.finished_epoch - build.started_epoch)) },
    { label: "Store path and products", cell: products_cell },
  ], builds, "Builds");
}

// The store path, then each product, with a download link for those that are files inside it.
function products_cell(build: BuildRecord): HTMLElement {
  return h("ul", { class: "products" },
    h("li", {}, build.store_path ? h("code", { class: "small" }, build.store_path) : h("span", { class: "muted" }, "No store path")),
    ...build.products.map((product, index) => h("li", {},
      h("span", { class: "badge tone-none" }, `${product.type} ${product.subtype}`), " ",
      product.size_bytes === null
        ? h("code", { class: "small", title: "Not a file inside the build's store path, so it cannot be downloaded" }, product.path)
        : [h("a", { href: `/api/builds/${build.id}/products/${index}`, download: product.name }, product.name), h("span", { class: "muted small" }, ` ${bytes(product.size_bytes)}`)],
    )));
}
