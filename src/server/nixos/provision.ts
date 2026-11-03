// The operations that provision new hosts: a nixos-anywhere install over SSH, and a build of install media.
//
// An install kexecs the target into an installer, partitions it with disko, installs the flake's configuration and
// reboots, or stops after partitioning. The new host's agent key arrives on the run's stdin and the agent places it
// (see agent/operations/provision.ts). The generated hardware-configuration.nix is printed after a marker so the page
// can show it.
//
// Install media is an installer ISO, the netboot (iPXE) files or a kexec tarball, built from the flake's configuration:
// its own `system.build` attribute when it has one, otherwise the configuration extended with nixpkgs' installer module.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ProvisioningSettings } from "../config.ts";
import { hardware_mark, innermost, media_mark, nix_string, operation_of, type InstallOperation, type MediaOperation } from "../../shared/operations.ts";

export { hardware_mark, media_mark, missing_tool_exit_code, nix_string } from "../../shared/operations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// What a person asks to install, checked by `parse_install_request`.
export interface InstallRequest {
  // The new host's name, which its agent logs in as and its deployment would be called.
  host: string;
  // The target's SSH address, a hostname or an IP address.
  address: string;
  user: string;
  port: number;
  flake: string;
  configuration: string;
  // The host that runs nixos-anywhere; the server's own host when null.
  agent: string | null;
  stop_after_partitioning: boolean;
  generate_hardware_config: boolean;
}

// What the install operation records, so the job's own command says what it installs.
export interface InstallRecord extends InstallRequest {
  // The new agent's public key line, or null when the install stops after partitioning and places no key.
  public_line: string | null;
  agent_key_path: string;
}

export type MediaFormat = "iso" | "netboot" | "kexec";

// What a media build's output says it builds.
export interface MediaRecord {
  flake: string;
  configuration: string;
  format: MediaFormat;
}

export const media_formats: MediaFormat[] = ["iso", "netboot", "kexec"];

export const media_format_labels: Record<MediaFormat, string> = { iso: "Installer ISO", netboot: "Netboot (iPXE)", kexec: "Kexec tarball" };

// ── Checking ─────────────────────────────────────────────────────────────────

const name_pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const address_pattern = /^[A-Za-z0-9][A-Za-z0-9.:%_-]*$/;
const user_pattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// Text that fits on one line and in a Nix string.
function single_line(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/[\n\r\0]/.test(value);
}

// Reads an install request from a page's form, or says what is wrong with it.
export function parse_install_request(body: unknown): InstallRequest | string {
  const values = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const host = values.host;
  if (typeof host !== "string" || !name_pattern.test(host)) return "Name the new host with letters, digits, - and _";
  const address = values.address;
  if (typeof address !== "string" || !address_pattern.test(address)) return "Give the target's SSH address as a hostname or IP address";
  const user = values.user === undefined || values.user === "" ? "root" : values.user;
  if (typeof user !== "string" || !user_pattern.test(user)) return "Give the SSH user as a plain user name";
  const port = values.port === undefined || values.port === "" ? 22 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Give the SSH port as a number from 1 to 65535";
  if (!single_line(values.flake)) return "Name the flake to install from";
  if (!single_line(values.configuration)) return "Name the nixosConfigurations attribute to install";
  const agent = values.agent === undefined || values.agent === null || values.agent === "" ? null : values.agent;
  if (agent !== null && typeof agent !== "string") return "Name the host that runs nixos-anywhere";
  return {
    host, address, user, port,
    flake: (values.flake as string).trim(),
    configuration: (values.configuration as string).trim(),
    agent,
    stop_after_partitioning: values.stop_after_partitioning === true,
    generate_hardware_config: values.generate_hardware_config !== false,
  };
}

// ── Install ──────────────────────────────────────────────────────────────────

// Runs nixos-anywhere with the key on stdin, then prints the hardware configuration it generated.
export function install_operation(settings: ProvisioningSettings, request: InstallRequest, public_line: string | null): InstallOperation {
  const record: InstallRecord = { ...request, public_line, agent_key_path: settings.agent_key_path };
  return {
    kind: "install",
    record: { ...record },
    tool: settings.nixos_anywhere_bin,
    ssh_key: settings.ssh_key ?? "",
    agent_key_path: public_line === null ? null : settings.agent_key_path,
    generate_hardware_config: request.generate_hardware_config,
    stop_after_partitioning: request.stop_after_partitioning,
    extra_args: settings.nixos_anywhere_args,
  };
}

// What an install job's command says it installs, or null when it holds no record.
export function parse_install_record(command: string): InstallRecord | null {
  const operation = operation_of(command);
  const inner = operation === null ? null : innermost(operation);
  return inner?.kind === "install" ? (inner.record as unknown as InstallRecord) : null;
}

// The hardware configuration an install printed, or null when it printed none.
export function parse_hardware_config(output: string): string | null {
  const start = output.indexOf(`\n${hardware_mark}\n`);
  if (start === -1) return null;
  const body_start = start + hardware_mark.length + 2;
  const end = output.indexOf(`\n${hardware_mark} end`, body_start);
  if (end === -1) return null;
  return output.slice(body_start, end).replace(/\n+$/, "\n");
}

// ── Snippets ─────────────────────────────────────────────────────────────────

// The lines a person adds to make an installed host a deployment, and to its own configuration for its agent.
export function install_snippets(record: InstallRecord, agent_url: string | null): { config_json: string; module_nix: string; host_nix: string } {
  const url = agent_url ?? "wss://x-nix.example/api/agent";
  const config_json = JSON.stringify({
    agents: { [record.host]: record.public_line },
    deployments: [{ id: record.host, host: record.host, flake: record.flake, configuration: record.configuration }],
  }, null, 2);
  const module_nix = [
    `services.x-nix.agents.${nix_attribute(record.host)} = ${nix_string(record.public_line ?? "")};`,
    `services.x-nix.deployments.${nix_attribute(record.host)} = {`,
    `  host = ${nix_string(record.host)};`,
    `  flake = ${nix_string(record.flake)};`,
    `  configuration = ${nix_string(record.configuration)};`,
    "};",
  ].join("\n");
  return { config_json, module_nix, host_nix: agent_snippet(record.host, record.agent_key_path, url) };
}

// The new host's own agent settings, which its flake configuration needs before it is installed.
export function agent_snippet(host: string, agent_key_path: string, agent_url: string): string {
  return [
    "services.x-nix-agent = {",
    "  enable = true;",
    `  url = ${nix_string(agent_url)};`,
    `  keyFile = ${nix_string(agent_key_path)};`,
    `  host = ${nix_string(host)};`,
    "};",
  ].join("\n");
}

// ── Media ────────────────────────────────────────────────────────────────────

function nix_attribute(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name) ? name : nix_string(name);
}

// The Nix expression for one medium: the configuration's own build when it has one, else it extended with the installer.
export function media_expression(flake: string, configuration: string, format: MediaFormat): string {
  const lines = [
    "let",
    `  system = (builtins.getFlake ${nix_string(flake)}).nixosConfigurations.${nix_string(configuration)};`,
    "  own = system.config.system.build;",
    "  with_module = path: system.extendModules { modules = [ ({ modulesPath, ... }: { imports = [ (modulesPath + path) ]; }) ]; };",
    '  netboot = if own ? netbootRamdisk then system else with_module "/installer/netboot/netboot-minimal.nix";',
    "  parts = netboot.config.system.build;",
    "  kernel_file = netboot.config.system.boot.loader.kernelFile;",
    "in",
  ];
  if (format === "iso") {
    lines.push('if own ? isoImage then own.isoImage else (with_module "/installer/cd-dvd/installation-cd-minimal.nix").config.system.build.isoImage');
  } else if (format === "netboot") {
    lines.push('system.pkgs.linkFarm "netboot" [',
      '  { name = kernel_file; path = "${parts.kernel}/${kernel_file}"; }',
      '  { name = "initrd"; path = "${parts.netbootRamdisk}/initrd"; }',
      '  { name = "netboot.ipxe"; path = "${parts.netbootIpxeScript}/netboot.ipxe"; }',
      "]");
  } else {
    lines.push("if own ? kexecTarball then own.kexecTarball else if own ? kexec_tarball then own.kexec_tarball else parts.kexecTarball or parts.kexecTree");
  }
  return lines.join("\n");
}

// Builds the medium with a link in the media folder that roots it, then prints the store path the link points to.
export function media_operation(settings: ProvisioningSettings, media_root_dir: string, flake: string, configuration: string, format: MediaFormat, link_name: string): MediaOperation {
  const record: MediaRecord = { flake, configuration, format };
  return {
    kind: "media",
    nix: [settings.nix_bin, ...settings.nix_args],
    record,
    media_root_dir,
    link: `${media_root_dir.replace(/\/+$/, "")}/${link_name}`,
    expression: media_expression(flake, configuration, format),
  };
}

// What a media build's command says it builds, or null when it holds no record.
export function parse_media_record(command: string): MediaRecord | null {
  const operation = operation_of(command);
  const inner = operation === null ? null : innermost(operation);
  return inner?.kind === "media" ? (inner.record as MediaRecord) : null;
}

// The store path a media build printed, or null when it printed none.
export function parse_media_path(output: string): string | null {
  const line = output.split("\n").filter((text) => text.startsWith(`${media_mark} `)).pop();
  return line === undefined ? null : line.slice(media_mark.length + 1).trim() || null;
}
