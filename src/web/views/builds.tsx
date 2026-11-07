// The Builds tab of the Jobs page: every finished build of a deployment or cache target with its result, duration, store path, log and
// products, filtered by deployment or cache and target.

import { Badge } from "@x-tech-laboratories/x-libs/web/preact/badges";
import { Section, Stack, Toolbar } from "@x-tech-laboratories/x-libs/web/preact/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/preact/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/preact/table";
import { bytes } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useRef } from "preact/hooks";
import { api, type BuildRecord, type BuildsAnswer } from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/preact/time";
import { JobsTabs } from "./jobs.tsx";
import { duration, refresh_interval_in_milliseconds } from "./shared.tsx";

// ── List ─────────────────────────────────────────────────────────────────────

export function BuildsView({ owner, target }: { owner: string; target: string }) {
  const answer = use_resource(() => {
    const search = new URLSearchParams({ limit: "200" });
    if (owner) search.set("owner", owner);
    if (target) search.set("target", target);
    return api<BuildsAnswer>(`/api/builds?${search}`);
  }, [owner, target], { refresh_in_milliseconds: refresh_interval_in_milliseconds });
  // The filters are drawn from the first answer, so a quiet refresh never takes a choice out from under the pointer.
  const first = useRef<BuildsAnswer | null>(null);
  if (first.current === null && answer.data !== null) first.current = answer.data;

  return (
    <div class="page">
      <h1>Jobs</h1>
      <JobsTabs active="builds" />
      <p class="muted">Every finished build, newest first, with its log and what it made. Products that are files inside their build's store path can be downloaded.</p>
      <Section title="History">
        <Toolbar>{first.current && <FilterFields answer={first.current} owner={owner} target={target} />}</Toolbar>
        <Stack>
          <Loaded resource={answer}>
            {(found) => (found.builds.length === 0
              ? <Empty title="No builds yet." hint="Each Build of a deployment, and each Build or Build all of a cache, shows here once it ends." />
              : <BuildsTable builds={found.builds} />)}
          </Loaded>
        </Stack>
      </Section>
    </div>
  );
}

// The deployment or cache and target choices, each moving to the filtered page.
function FilterFields({ answer, owner, target }: { answer: BuildsAnswer; owner: string; target: string }) {
  const owners = [...new Set(answer.targets.map((entry) => entry.owner_id))];
  const targets = [...new Set(answer.targets.filter((entry) => !owner || entry.owner_id === owner).map((entry) => entry.target))];
  const choose = (values: Record<string, string | null>) => {
    location.hash = link(["builds"], { owner, target, ...values });
  };
  const options = (choices: string[], everything: string) => [
    <option key="" value="">{everything}</option>,
    ...choices.map((choice) => <option key={choice} value={choice}>{choice}</option>),
  ];
  return <>
    <label class="field">
      <span class="field-label">For</span>
      <select value={owner} onChange={(event) => choose({ owner: event.currentTarget.value, target: null })}>{options(owners, "Every deployment and cache")}</select>
    </label>
    <label class="field">
      <span class="field-label">Target</span>
      <select value={target} onChange={(event) => choose({ target: event.currentTarget.value })}>{options(targets, "Every target")}</select>
    </label>
  </>;
}

function BuildsTable({ builds }: { builds: BuildRecord[] }) {
  return (
    <DataTable<BuildRecord> caption="Builds" rows={builds} row_key={(build) => build.id} columns={[
      { label: "Build", cell: (build) => <a href={link(["jobs", String(build.job_id)])} title="Its log">#{build.job_id}</a> },
      { label: "For", cell: (build) => <a href={link(["builds"], { owner: build.owner_id })}>{build.owner_id}</a> },
      { label: "Target", cell: (build) => <a href={link(["builds"], { owner: build.owner_id, target: build.target })}>{build.target}</a> },
      { label: "Result", cell: (build) => <Badge tone={build.succeeded ? "good" : "bad"}>{build.succeeded ? "built" : "failed"}</Badge> },
      { label: "Finished", cell: (build) => <Age epoch={build.finished_epoch} /> },
      { label: "Took", cell: (build) => duration(Math.max(0, build.finished_epoch - build.started_epoch)) },
      { label: "Store path and products", cell: (build) => <Products build={build} /> },
    ]} />
  );
}

// The store path, then each product, with a download link for those that are files inside it.
function Products({ build }: { build: BuildRecord }) {
  return (
    <ul class="products">
      <li>{build.store_path ? <code class="small">{build.store_path}</code> : <span class="muted">No store path</span>}</li>
      {build.products.map((product, index) => (
        <li key={index}>
          <Badge>{product.type} {product.subtype}</Badge>{" "}
          {product.size_bytes === null
            ? <code class="small" title="Not a file inside the build's store path, so it cannot be downloaded">{product.path}</code>
            : <><a href={`/api/builds/${build.id}/products/${index}`} download={product.name}>{product.name}</a><span class="muted small"> {bytes(product.size_bytes)}</span></>}
        </li>
      ))}
    </ul>
  );
}
