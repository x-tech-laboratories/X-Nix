// The Provision page: install NixOS on a new host with nixos-anywhere, see each install with its hardware configuration
// and the snippets that keep the host, the agent keys X-Nix made, and build install media to download.

import {
  api, type ActionOutcome, type AgentEntry, type Deployment, type Health, type InstallView, type MediaFormat, type MediaView, type ProvisionedAgent,
  type Provisioning,
} from "../api.ts";
import { age, bytes, h, stamp } from "../dom.ts";
import { link } from "../router.ts";
import { confirm_dialog, data_table, empty, facts, job_badge, load, section, toast } from "../ui.ts";
import { refresh_interval_in_milliseconds, type View } from "./shared.ts";

const format_labels: Record<MediaFormat, string> = { iso: "Installer ISO", netboot: "Netboot (iPXE)", kexec: "Kexec tarball" };

// ── Page ─────────────────────────────────────────────────────────────────────

export function provision_view(): View {
  const install_form = h("div");
  const media_form = h("div");
  const installs = h("div");
  const keys = h("div");
  const media = h("div");

  const fetch_provisioning = () => api<Provisioning>("/api/provisioning");
  const refresh = (quiet: boolean): Promise<unknown> => Promise.all([
    load(installs, async () => {
      const found = (await fetch_provisioning()).installs;
      return found.length === 0 ? empty("No installs yet.") : found.map(install_card);
    }, { quiet }),
    load(keys, async () => keys_table((await fetch_provisioning()).provisioned_agents, () => refresh(true)), { quiet }),
    load(media, async () => media_table((await fetch_provisioning()).media, () => refresh(true)), { quiet }),
  ]);

  // The forms are built once, so a refresh never wipes what a person is typing.
  void load(install_form, async () => {
    const [provisioning, health, agents] = await Promise.all([api<Provisioning>("/api/provisioning"), api<Health>("/api/health"), api<AgentEntry[]>("/api/agents")]);
    return install_fields(provisioning, health, agents, () => refresh(true));
  });
  void load(media_form, async () => media_fields(await api<Deployment[]>("/api/deployments"), () => refresh(true)));
  void refresh(false);
  const timer = setInterval(() => void refresh(true), refresh_interval_in_milliseconds);

  return {
    title: "Provision",
    root: h("div", { class: "page" },
      h("h1", {}, "Provision"),
      h("p", { class: "muted" }, "Install NixOS on a reachable Linux host with nixos-anywhere, and build install media for a configuration."),
      section("Install NixOS on a host", install_form),
      section("Installs", installs),
      section("Agent keys made here", keys),
      section("Build install media", media_form),
      section("Install media", media),
    ),
    dispose: () => clearInterval(timer),
  };
}

// ── Install ──────────────────────────────────────────────────────────────────

function row(label: string, control: HTMLElement, hint: string | null = null): HTMLElement {
  const id = control.id;
  return h("div", { class: "form-row" }, h("label", { for: id }, label), h("div", {}, control, hint && h("p", { class: "muted small" }, hint)));
}

function text_input(id: string, attributes: Record<string, string | boolean> = {}): HTMLInputElement {
  return h("input", { id, type: "text", autocomplete: "off", spellcheck: "false", ...attributes });
}

function install_fields(provisioning: Provisioning, health: Health, agents: AgentEntry[], done: () => Promise<unknown>): HTMLElement {
  const host = text_input("install-host", { required: true, placeholder: "freya" });
  const address = text_input("install-address", { required: true, placeholder: "192.0.2.10" });
  const user = text_input("install-user", { value: "root" });
  const port = h("input", { id: "install-port", type: "number", min: "1", max: "65535", value: "22" });
  const flake = text_input("install-flake", { required: true, placeholder: "github:owner/nixos-config" });
  const configuration = text_input("install-configuration", { required: true, placeholder: "freya" });
  const default_agent = provisioning.install_agent ?? health.server_name;
  const runners = [health.server_name, ...agents.filter((agent) => agent.status !== null).map((agent) => agent.host)];
  if (!runners.includes(default_agent)) runners.push(default_agent);
  const agent = h("select", { id: "install-agent" }, ...runners.map((name) => h("option", { value: name, selected: name === default_agent }, name === health.server_name ? `${name} (this server)` : name)));
  const stop = h("input", { id: "install-stop", type: "checkbox" });
  const hardware = h("input", { id: "install-hardware", type: "checkbox", checked: true });
  const confirm = text_input("install-confirm", { required: true });
  const submit = h("button", { type: "submit", class: "danger solid", disabled: true }, "Wipe and install");
  const warning_target = h("strong", {}, "the target");

  const sync = () => {
    warning_target.textContent = address.value.trim() || "the target";
    submit.disabled = provisioning.install_refusal !== null || address.value.trim() === "" || confirm.value !== address.value.trim();
  };
  address.addEventListener("input", sync);
  confirm.addEventListener("input", sync);

  const form = h("form", { onsubmit: async (event: Event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const outcome = await api<ActionOutcome>("/api/provisioning/install", "POST", {
        host: host.value.trim(), address: address.value.trim(), user: user.value.trim(), port: Number(port.value), flake: flake.value.trim(),
        configuration: configuration.value.trim(), agent: agent.value === health.server_name ? null : agent.value, stop_after_partitioning: stop.checked,
        generate_hardware_config: hardware.checked, confirm: confirm.value,
      });
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
      confirm.value = "";
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    sync();
    await done();
  } },
    provisioning.install_refusal && h("p", { class: "banner tone-fill-warn" }, provisioning.install_refusal),
    h("div", { class: "form-rows" },
      row("New host's name", host, "The name its agent logs in as, and its deployment's id."),
      row("SSH address", address, "A hostname or IP address of a running Linux system, reached with the key in provisioning.ssh_key."),
      row("SSH user", user),
      row("SSH port", port),
      row("Flake", flake),
      row("Configuration", configuration, "The nixosConfigurations attribute, which must hold a disko layout."),
      row("Runs nixos-anywhere", agent),
      row("Stop after partitioning", stop, "Runs only the kexec and disko phases: the disks are wiped and partitioned, and nothing is installed."),
      row("Generate hardware-configuration.nix", hardware, "Runs nixos-generate-config on the target; the result is shown with the install."),
    ),
    h("p", { class: "muted small" }, `The configuration needs the agent before it is installed, so it can log in on first boot; X-Nix makes the key and places it at ${provisioning.agent_key_path}:`),
    h("pre", { class: "output" }, provisioning.agent_snippet),
    h("div", { class: "banner tone-fill-bad", role: "note" },
      h("p", {}, h("strong", {}, "This wipes the target's disks. "), "nixos-anywhere boots ", warning_target,
        " into an installer and repartitions every disk the configuration's disko layout names. Everything on them is lost, and it cannot be undone."),
      row("Type the SSH address to confirm", confirm)),
    h("div", { class: "form-actions" }, submit));
  return form;
}

function install_card(install: InstallView): HTMLElement {
  const record = install.record;
  const job = install.job;
  const what = record === null ? `Install #${job.id}` : `${record.host} on ${record.user}@${record.address}`;
  return h("article", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, h("a", { href: link(["jobs", String(job.id)]) }, what)), job_badge(job.state)),
    facts([
      ["Configuration", record ? h("code", {}, `${record.flake}#${record.configuration}`) : "—"],
      ["What", record?.stop_after_partitioning ? "Partition only" : "Full install"],
      ["Ran on", job.agent ?? "this server"],
      ["Started", h("span", { title: stamp(job.started_epoch) }, age(job.started_epoch))],
      ["Agent key", record?.public_line ? install.key_accepted ? "Accepted" : job.state === "succeeded" ? "Not accepted" : "Accepted once it succeeds" : "None"],
      ["Last line", h("span", { class: "muted small" }, job.error ?? job.progress ?? "")],
    ]),
    install.hardware_config && h("details", { class: "form-group" }, h("summary", {}, "hardware-configuration.nix"), h("pre", { class: "output" }, install.hardware_config)),
    install.snippets && h("details", { class: "form-group", open: true }, h("summary", {}, "Keep this host"),
      h("p", { class: "muted small" }, "X-Nix accepts its agent key from its own record; to declare the key and watch the host as a deployment, add these lines and restart X-Nix."),
      h("p", { class: "small" }, "In the config file:"), h("pre", { class: "output" }, install.snippets.config_json),
      h("p", { class: "small" }, "Or in the server's NixOS configuration:"), h("pre", { class: "output" }, install.snippets.module_nix),
      h("p", { class: "small" }, "The new host's own configuration:"), h("pre", { class: "output" }, install.snippets.host_nix)));
}

// ── Keys ─────────────────────────────────────────────────────────────────────

function keys_table(agents: ProvisionedAgent[], done: () => Promise<unknown>): HTMLElement {
  if (agents.length === 0) return empty("No keys made yet.", "A full install makes its host's agent key, which is accepted once the install succeeds.");
  const forget = (agent: ProvisionedAgent) => confirm_dialog(`Forget ${agent.host}'s key`,
    `Stop accepting the agent key X-Nix made for ${agent.host}? Its agent is hung up on and cannot log in again unless the config declares its key.`,
    "Forget", async () => {
      try {
        toast((await api<ActionOutcome>(`/api/provisioning/agents/${encodeURIComponent(agent.host)}/forget`, "POST")).message, "good");
      } catch (error) {
        toast((error as Error).message, "bad");
      }
      await done();
    });
  return data_table<ProvisionedAgent>([
    { label: "Host", cell: (agent) => h("strong", {}, agent.host) },
    { label: "Fingerprint", cell: (agent) => h("code", { class: "small", title: agent.public_line }, agent.fingerprint) },
    { label: "Install", cell: (agent) => h("a", { href: link(["jobs", String(agent.job_id)]) }, `#${agent.job_id}`) },
    { label: "Added", cell: (agent) => h("span", { title: stamp(agent.added_epoch) }, age(agent.added_epoch)) },
    { label: "State", cell: (agent) => (agent.overridden ? h("span", { class: "muted" }, "The config declares this host's key, which is used instead") : "Accepted") },
    { label: "Actions", cell: (agent) => h("div", { class: "row-actions" }, h("button", { class: "danger", onclick: () => forget(agent) }, "Forget")) },
  ], agents, "Agent keys made here");
}

// ── Media ────────────────────────────────────────────────────────────────────

function media_fields(deployments: Deployment[], done: () => Promise<unknown>): HTMLElement {
  const deployment = h("select", { id: "media-deployment" },
    h("option", { value: "" }, "Another flake"),
    ...deployments.map((item) => h("option", { value: item.id }, item.name)));
  const flake = text_input("media-flake", { placeholder: "github:owner/nixos-config" });
  const configuration = text_input("media-configuration", { placeholder: "the deployment's configuration" });
  const format = h("select", { id: "media-format" }, ...(Object.keys(format_labels) as MediaFormat[]).map((name) => h("option", { value: name }, format_labels[name])));
  const submit = h("button", { type: "submit", class: "accent solid" }, "Build");
  const flake_row = row("Flake", flake);
  const sync = () => {
    flake_row.hidden = deployment.value !== "";
  };
  deployment.addEventListener("change", sync);
  if (deployments.length > 0) deployment.value = deployments[0].id;
  sync();

  return h("form", { onsubmit: async (event: Event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const outcome = await api<ActionOutcome>("/api/provisioning/media", "POST", {
        deployment: deployment.value, flake: flake.value.trim(), configuration: configuration.value.trim(), format: format.value,
      });
      toast(outcome.message, "good", outcome.job_id === null ? null : { href: link(["jobs", String(outcome.job_id)]), text: "Follow it" });
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    submit.disabled = false;
    await done();
  } },
    h("div", { class: "form-rows" },
      row("For", deployment),
      flake_row,
      row("Configuration", configuration, "The nixosConfigurations attribute; left empty, the deployment's own."),
      row("Format", format, "The configuration's own isoImage, netboot or kexecTarball build when it has one, otherwise it extended with nixpkgs' installer. Media is built on this server."),
    ),
    h("div", { class: "form-actions" }, submit));
}

function media_table(builds: MediaView[], done: () => Promise<unknown>): HTMLElement {
  if (builds.length === 0) return empty("No media built yet.");
  const remove = async (build: MediaView) => {
    try {
      toast((await api<ActionOutcome>(`/api/provisioning/media/${build.job.id}/remove`, "POST")).message, "good");
    } catch (error) {
      toast((error as Error).message, "bad");
    }
    await done();
  };
  return data_table<MediaView>([
    { label: "Job", cell: (build) => h("a", { href: link(["jobs", String(build.job.id)]) }, `#${build.job.id}`) },
    { label: "Format", cell: (build) => (build.format ? format_labels[build.format] : "—") },
    { label: "Configuration", cell: (build) => (build.configuration ? h("code", { class: "small" }, `${build.flake}#${build.configuration}`) : "—") },
    { label: "State", cell: (build) => job_badge(build.job.state) },
    { label: "Started", cell: (build) => h("span", { title: stamp(build.job.started_epoch) }, age(build.job.started_epoch)) },
    { label: "Files", cell: (build) => {
      if (build.files === null) return h("span", { class: "muted small" }, build.job.state === "succeeded" ? "Removed from the store" : build.job.error ?? build.job.progress ?? "");
      return h("ul", { class: "plain-list" }, ...build.files.map((file) => h("li", {},
        h("a", { href: `/api/provisioning/media/${build.job.id}/download?path=${encodeURIComponent(file.path)}`, download: "" }, file.path),
        h("span", { class: "muted small" }, ` ${bytes(file.size)}`))));
    } },
    { label: "Actions", cell: (build) => build.files !== null && h("div", { class: "row-actions" },
      h("button", { class: "danger", onclick: () => confirm_dialog(`Remove media build #${build.job.id}`,
        "Remove the link that keeps this build in the store? The next garbage collection deletes it.", "Remove", () => remove(build)) }, "Remove")) },
  ], builds, "Install media");
}
