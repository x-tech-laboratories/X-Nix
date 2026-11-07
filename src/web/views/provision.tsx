// The Provision page: install NixOS on a new host with nixos-anywhere, see each install with its hardware configuration
// and the snippets that keep the host, the agent keys X-Nix made for hosts the config does not name yet, and build install
// media to download. A named host shows its key on its Machine tab.

import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Facts, Section, Stack } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { bytes } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  api, type ActionOutcome, type AgentEntry, type Deployment, type Health, type Host, type InstallView, type MediaFormat, type MediaView, type ProvisionedAgent,
  type Provisioning,
} from "../api.ts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { JobBadge } from "../ui.tsx";
import { forget_key } from "./hosts.tsx";
import { error_toast, job_toast, refresh_interval_in_milliseconds } from "./shared.tsx";

const format_labels: Record<MediaFormat, string> = { iso: "Installer ISO", netboot: "Netboot (iPXE)", kexec: "Kexec tarball" };

// ── Page ─────────────────────────────────────────────────────────────────────

export function ProvisionView() {
  const refresh = { refresh_in_milliseconds: refresh_interval_in_milliseconds };
  const fetch_provisioning = () => api<Provisioning>("/api/provisioning");
  const installs = use_resource(async () => (await fetch_provisioning()).installs, [], refresh);
  const keys = use_resource(async () => {
    const [provisioning, hosts] = await Promise.all([fetch_provisioning(), api<Host[]>("/api/hosts")]);
    const named = new Set(hosts.map((host) => host.name));
    return provisioning.provisioned_agents.filter((agent) => !named.has(agent.host));
  }, [], refresh);
  const media = use_resource(async () => (await fetch_provisioning()).media, [], refresh);
  // The forms are loaded once, so a refresh never wipes what a person is typing.
  const install_form = use_resource(async () => {
    const [provisioning, health, agents] = await Promise.all([fetch_provisioning(), api<Health>("/api/health"), api<AgentEntry[]>("/api/agents")]);
    return { provisioning, health, agents };
  }, []);
  const media_form = use_resource(() => api<Deployment[]>("/api/deployments"), []);
  const done = async () => {
    await Promise.all([installs.reload(true), keys.reload(true), media.reload(true)]);
  };

  return (
    <div className="page">
      <h1>Provision</h1>
      <p className="muted">Install NixOS on a reachable Linux host with nixos-anywhere, and build install media for a configuration.</p>
      <Section title="Install NixOS on a host">
        <Stack><Loaded resource={install_form}>{(found) => <InstallFields {...found} done={done} />}</Loaded></Stack>
      </Section>
      <Section title="Installs">
        <Stack><Loaded resource={installs}>{(found) => (found.length === 0 ? <Empty title="No installs yet." /> : found.map((install) => <InstallCard key={install.job.id} install={install} />))}</Loaded></Stack>
      </Section>
      <Section title="Agent keys for unnamed hosts">
        <Stack><Loaded resource={keys}>{(found) => <KeysTable agents={found} done={done} />}</Loaded></Stack>
      </Section>
      <Section title="Build install media">
        <Stack><Loaded resource={media_form}>{(found) => <MediaFields deployments={found} done={done} />}</Loaded></Stack>
      </Section>
      <Section title="Install media">
        <Stack><Loaded resource={media}>{(found) => <MediaTable builds={found} done={done} />}</Loaded></Stack>
      </Section>
    </div>
  );
}

// ── Install ──────────────────────────────────────────────────────────────────

function FormRow({ label, id, hint, hidden = false, children }: { label: string; id: string; hint?: string; hidden?: boolean; children: ReactNode }) {
  return (
    <div className="form-row" hidden={hidden}>
      <label htmlFor={id}>{label}</label>
      <div>{children}{hint && <p className="muted small">{hint}</p>}</div>
    </div>
  );
}

// The text a form field holds, by its name.
function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

const text_field = { type: "text", autoComplete: "off", spellCheck: false } as const;

function InstallFields({ provisioning, health, agents, done }: { provisioning: Provisioning; health: Health; agents: AgentEntry[]; done: () => void }) {
  const [address, set_address] = useState("");
  const [confirm, set_confirm] = useState("");
  const [busy, set_busy] = useState(false);
  const default_agent = provisioning.install_agent ?? health.server_name;
  const runners = [health.server_name, ...agents.filter((agent) => agent.status !== null).map((agent) => agent.host)];
  if (!runners.includes(default_agent)) runners.push(default_agent);
  const ready = provisioning.install_refusal === null && address.trim() !== "" && confirm === address.trim();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const agent = field(form, "agent");
    set_busy(true);
    try {
      const outcome = await api<ActionOutcome>("/api/provisioning/install", "POST", {
        host: field(form, "host"), address: address.trim(), user: field(form, "user"), port: Number(form.get("port")), flake: field(form, "flake"),
        configuration: field(form, "configuration"), agent: agent === health.server_name ? null : agent, stop_after_partitioning: form.has("stop"),
        generate_hardware_config: form.has("hardware"), confirm,
      });
      job_toast(outcome.message, outcome.job_id);
      set_confirm("");
    } catch (error) {
      error_toast(error);
    }
    set_busy(false);
    done();
  };

  return (
    <form className="stack tight" onSubmit={(event) => void submit(event)}>
      {provisioning.install_refusal && <p className="banner tone-fill-warn">{provisioning.install_refusal}</p>}
      <div className="form-rows">
        <FormRow label="New host's name" id="install-host" hint="The name its agent logs in as, and its deployment's id.">
          <input {...text_field} id="install-host" name="host" required placeholder="freya" />
        </FormRow>
        <FormRow label="SSH address" id="install-address" hint="A hostname or IP address of a running Linux system, reached with the key in provisioning.ssh_key.">
          <input {...text_field} id="install-address" name="address" required placeholder="192.0.2.10" value={address} onChange={(event) => set_address(event.currentTarget.value)} />
        </FormRow>
        <FormRow label="SSH user" id="install-user"><input {...text_field} id="install-user" name="user" defaultValue="root" /></FormRow>
        <FormRow label="SSH port" id="install-port"><input id="install-port" name="port" type="number" min="1" max="65535" defaultValue="22" /></FormRow>
        <FormRow label="Flake" id="install-flake"><input {...text_field} id="install-flake" name="flake" required placeholder="github:owner/nixos-config" /></FormRow>
        <FormRow label="Configuration" id="install-configuration" hint="The nixosConfigurations attribute, which must hold a disko layout.">
          <input {...text_field} id="install-configuration" name="configuration" required placeholder="freya" />
        </FormRow>
        <FormRow label="Runs nixos-anywhere" id="install-agent">
          <select id="install-agent" name="agent" defaultValue={default_agent}>
            {runners.map((name) => <option key={name} value={name}>{name === health.server_name ? `${name} (this server)` : name}</option>)}
          </select>
        </FormRow>
        <FormRow label="Stop after partitioning" id="install-stop" hint="Runs only the kexec and disko phases: the disks are wiped and partitioned, and nothing is installed.">
          <input id="install-stop" name="stop" type="checkbox" />
        </FormRow>
        <FormRow label="Generate hardware-configuration.nix" id="install-hardware" hint="Runs nixos-generate-config on the target; the result is shown with the install.">
          <input id="install-hardware" name="hardware" type="checkbox" defaultChecked />
        </FormRow>
      </div>
      <p className="muted small">The configuration needs the agent before it is installed, so it can log in on first boot; X-Nix makes the key and places it at {provisioning.agent_key_path}:</p>
      <pre className="output">{provisioning.agent_snippet}</pre>
      <div className="banner tone-fill-bad" role="note">
        <p>
          <strong>This wipes the target's disks. </strong>nixos-anywhere boots <strong>{address.trim() || "the target"}</strong> into an installer and repartitions every disk
          the configuration's disko layout names. Everything on them is lost, and it cannot be undone.
        </p>
        <FormRow label="Type the SSH address to confirm" id="install-confirm">
          <input {...text_field} id="install-confirm" required value={confirm} onChange={(event) => set_confirm(event.currentTarget.value)} />
        </FormRow>
      </div>
      <div className="form-actions"><button type="submit" className="danger solid" disabled={!ready || busy}>Wipe and install</button></div>
    </form>
  );
}

function InstallCard({ install }: { install: InstallView }) {
  const record = install.record;
  const job = install.job;
  const what = record === null ? `Install #${job.id}` : `${record.host} on ${record.user}@${record.address}`;
  return (
    <article className="panel">
      <div className="panel-head"><h2><a href={link(["jobs", String(job.id)])}>{what}</a></h2><JobBadge state={job.state} /></div>
      <Facts rows={[
        ["Configuration", record ? <code>{`${record.flake}#${record.configuration}`}</code> : "—"],
        ["What", record?.stop_after_partitioning ? "Partition only" : "Full install"],
        ["Ran on", job.agent ?? "this server"],
        ["Started", <Age epoch={job.started_epoch} />],
        ["Agent key", record?.public_line ? install.key_accepted ? "Accepted" : job.state === "succeeded" ? "Not accepted" : "Accepted once it succeeds" : "None"],
        ["Last line", <span className="muted small">{job.error ?? job.progress ?? ""}</span>],
      ]} />
      {install.hardware_config && <details className="form-group"><summary>hardware-configuration.nix</summary><pre className="output">{install.hardware_config}</pre></details>}
      {install.snippets && (
        <details className="form-group" open>
          <summary>Keep this host</summary>
          <p className="muted small">X-Nix accepts its agent key from its own record; to declare the key and watch the host as a deployment, add these lines and restart X-Nix.</p>
          <p className="small">In the config file:</p><pre className="output">{install.snippets.config_json}</pre>
          <p className="small">Or in the server's NixOS configuration:</p><pre className="output">{install.snippets.module_nix}</pre>
          <p className="small">The new host's own configuration:</p><pre className="output">{install.snippets.host_nix}</pre>
        </details>
      )}
    </article>
  );
}

// ── Keys ─────────────────────────────────────────────────────────────────────

function KeysTable({ agents, done }: { agents: ProvisionedAgent[]; done: () => void }) {
  if (agents.length === 0) return <Empty title="No keys waiting." hint="A full install makes its host's agent key; once the config names the host, its Machine tab shows the key." />;
  return (
    <DataTable<ProvisionedAgent> caption="Agent keys for unnamed hosts" rows={agents} row_key={(agent) => agent.host} columns={[
      { label: "Host", cell: (agent) => <strong>{agent.host}</strong> },
      { label: "Fingerprint", cell: (agent) => <code className="small" title={agent.public_line}>{agent.fingerprint}</code> },
      { label: "Install", cell: (agent) => <a href={link(["jobs", String(agent.job_id)])}>#{agent.job_id}</a> },
      { label: "Added", cell: (agent) => <Age epoch={agent.added_epoch} /> },
      { label: "Actions", cell: (agent) => <div className="row-actions"><button className="danger" onClick={() => forget_key(agent, done)}>Forget</button></div> },
    ]} />
  );
}

// ── Media ────────────────────────────────────────────────────────────────────

function MediaFields({ deployments, done }: { deployments: Deployment[]; done: () => void }) {
  const [deployment, set_deployment] = useState(deployments.length > 0 ? deployments[0].id : "");
  const [busy, set_busy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    set_busy(true);
    try {
      const outcome = await api<ActionOutcome>("/api/provisioning/media", "POST", {
        deployment, flake: field(form, "flake"), configuration: field(form, "configuration"), format: field(form, "format"),
      });
      job_toast(outcome.message, outcome.job_id);
    } catch (error) {
      error_toast(error);
    }
    set_busy(false);
    done();
  };

  return (
    <form className="stack tight" onSubmit={(event) => void submit(event)}>
      <div className="form-rows">
        <FormRow label="For" id="media-deployment">
          <select id="media-deployment" value={deployment} onChange={(event) => set_deployment(event.currentTarget.value)}>
            <option value="">Another flake</option>
            {deployments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </FormRow>
        <FormRow label="Flake" id="media-flake" hidden={deployment !== ""}><input {...text_field} id="media-flake" name="flake" placeholder="github:owner/nixos-config" /></FormRow>
        <FormRow label="Configuration" id="media-configuration" hint="The nixosConfigurations attribute; left empty, the deployment's own.">
          <input {...text_field} id="media-configuration" name="configuration" placeholder="the deployment's configuration" />
        </FormRow>
        <FormRow label="Format" id="media-format" hint="The configuration's own isoImage, netboot or kexecTarball build when it has one, otherwise it extended with nixpkgs' installer. Media is built on this server.">
          <select id="media-format" name="format">
            {(Object.keys(format_labels) as MediaFormat[]).map((name) => <option key={name} value={name}>{format_labels[name]}</option>)}
          </select>
        </FormRow>
      </div>
      <div className="form-actions"><button type="submit" className="accent solid" disabled={busy}>Build</button></div>
    </form>
  );
}

function MediaTable({ builds, done }: { builds: MediaView[]; done: () => void }) {
  if (builds.length === 0) return <Empty title="No media built yet." />;
  const remove = async (build: MediaView) => {
    try {
      toast((await api<ActionOutcome>(`/api/provisioning/media/${build.job.id}/remove`, "POST")).message, { tone: "good" });
    } catch (error) {
      error_toast(error);
    }
    done();
  };
  return (
    <DataTable<MediaView> caption="Install media" rows={builds} row_key={(build) => build.job.id} columns={[
      { label: "Job", cell: (build) => <a href={link(["jobs", String(build.job.id)])}>#{build.job.id}</a> },
      { label: "Format", cell: (build) => (build.format ? format_labels[build.format] : "—") },
      { label: "Configuration", cell: (build) => (build.configuration ? <code className="small">{`${build.flake}#${build.configuration}`}</code> : "—") },
      { label: "State", cell: (build) => <JobBadge state={build.job.state} /> },
      { label: "Started", cell: (build) => <Age epoch={build.job.started_epoch} /> },
      { label: "Files", cell: (build) => {
        if (build.files === null) return <span className="muted small">{build.job.state === "succeeded" ? "Removed from the store" : build.job.error ?? build.job.progress ?? ""}</span>;
        return (
          <ul className="plain-list">
            {build.files.map((file) => (
              <li key={file.path}>
                <a href={`/api/provisioning/media/${build.job.id}/download?path=${encodeURIComponent(file.path)}`} download="">{file.path}</a>
                <span className="muted small"> {bytes(file.size)}</span>
              </li>
            ))}
          </ul>
        );
      } },
      { label: "Actions", cell: (build) => build.files !== null && (
        <div className="row-actions">
          <button className="danger" onClick={() => confirm_dialog({
            title: `Remove media build #${build.job.id}`,
            message: "Remove the link that keeps this build in the store? The next garbage collection deletes it.",
            confirm_label: "Remove",
            danger: true,
            run: () => remove(build),
          })}>Remove</button>
        </div>
      ) },
    ]} />
  );
}
