// The shell commands that provision new hosts: a nixos-anywhere install over SSH, and a build of install media.
//
// An install kexecs the target into an installer, partitions it with disko, installs the flake's configuration and
// reboots, or stops after partitioning. The new host's agent key arrives on the script's stdin, is written into a
// private folder that nixos-anywhere copies onto the new system with `--extra-files`, and is removed with that folder
// when the script ends. The generated hardware-configuration.nix is printed after a marker so the page can show it.
//
// Install media is an installer ISO, the netboot (iPXE) files or a kexec tarball, built from the flake's configuration:
// its own `system.build` attribute when it has one, otherwise the configuration extended with nixpkgs' installer module.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ProvisioningSettings } from "../config.ts";
import { shell_quote } from "./commands.ts";

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

// What the install script's first line records, so the job's own command says what it installs.
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

// Starts the comment line at the top of an install's script naming what it installs.
export const install_mark = "@@x-nix-install";

// Surrounds the hardware configuration an install generated.
export const hardware_mark = "@@x-nix-hardware-config";

// Starts the comment line at the top of a media build's script naming what it builds.
export const media_record_mark = "@@x-nix-media-for";

// Starts the line naming the store path a media build made.
export const media_mark = "@@x-nix-media";

// The exit status sh gives a program it cannot find, which a script also uses for a missing tool.
export const missing_tool_exit_code = 127;

// ── Checking ─────────────────────────────────────────────────────────────────

const name_pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const address_pattern = /^[A-Za-z0-9][A-Za-z0-9.:%_-]*$/;
const user_pattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// Text that fits on one line of a shell script and a Nix string.
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

// The folders above the key, each made with the mode the new system keeps for it, since nixos-anywhere copies modes.
function key_folders(agent_key_path: string): { path: string; mode: string }[] {
  const parts = agent_key_path.split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, index) => ({ path: parts.slice(0, index + 1).join("/"), mode: index === parts.length - 1 ? "700" : "755" }));
}

// Runs nixos-anywhere with the key on stdin, then prints the hardware configuration it generated; exits with its status.
export function install_command(settings: ProvisioningSettings, request: InstallRequest, public_line: string | null): string {
  const record: InstallRecord = { ...request, public_line, agent_key_path: settings.agent_key_path };
  const tool = settings.nixos_anywhere_bin;
  const hardware = '"$t/hardware-configuration.nix"';
  const ssh_key = settings.ssh_key ?? "";
  const lines = [
    `# ${install_mark} ${JSON.stringify(record)}`,
    `echo ${shell_quote(`Installing ${request.flake}#${request.configuration} on ${request.user}@${request.address}${request.stop_after_partitioning ? ", stopping after partitioning" : ""}`)}`,
    `if ! command -v ${shell_quote(tool)} >/dev/null 2>&1; then echo ${shell_quote(`${tool} is not on this host's PATH; add pkgs.nixos-anywhere to the PATH of the host that runs installs`)}; exit ${missing_tool_exit_code}; fi`,
    `if [ ! -r ${shell_quote(ssh_key)} ]; then echo ${shell_quote(`Cannot read the SSH key ${ssh_key} on this host`)}; exit 2; fi`,
    "t=$(mktemp -d) || exit 1",
    `trap 'rm -rf "$t"' EXIT`,
  ];
  const anywhere = [
    shell_quote(tool),
    "--flake", shell_quote(`${request.flake}#${request.configuration}`),
    "--target-host", shell_quote(`${request.user}@${request.address}`),
    "--ssh-port", String(request.port),
    "-i", shell_quote(ssh_key),
  ];
  if (public_line !== null) {
    // The copied folder becomes the new system's root, so it and every folder in it keep the modes those folders need.
    lines.push('mkdir -m 755 "$t/extra" || exit 1');
    for (const folder of key_folders(settings.agent_key_path)) lines.push(`mkdir -m ${folder.mode} "$t/extra/"${shell_quote(folder.path)} || exit 1`);
    const key_file = `"$t/extra/"${shell_quote(settings.agent_key_path.replace(/^\/+/, ""))}`;
    lines.push(`(umask 077 && cat > ${key_file}) || exit 1`);
    lines.push(`if [ ! -s ${key_file} ]; then echo "The new host's agent key did not arrive"; exit 2; fi`);
    anywhere.push("--extra-files", '"$t/extra"');
  }
  if (request.generate_hardware_config) anywhere.push("--generate-hardware-config", "nixos-generate-config", hardware);
  if (request.stop_after_partitioning) anywhere.push("--phases", "kexec,disko");
  anywhere.push(...settings.nixos_anywhere_args.map(shell_quote));
  lines.push(`${anywhere.join(" ")} </dev/null`, "rc=$?");
  if (request.generate_hardware_config) {
    lines.push(`if [ -s ${hardware} ]; then echo "${hardware_mark}"; cat ${hardware}; echo; echo "${hardware_mark} end"; fi`);
  }
  lines.push('exit "$rc"');
  return lines.join("\n");
}

// What an install job's command says it installs, or null when it holds no record.
export function parse_install_record(command: string): InstallRecord | null {
  return parse_record<InstallRecord>(command, install_mark);
}

// The JSON on the comment line that starts with the mark, or null when there is none.
function parse_record<Shape>(command: string, mark: string): Shape | null {
  const line = command.split("\n").find((text) => text.startsWith(`# ${mark} `));
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice(mark.length + 3)) as Shape;
  } catch {
    return null;
  }
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

// A Nix string literal holding the text as it is.
export function nix_string(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${")}"`;
}

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
export function media_command(settings: ProvisioningSettings, media_root_dir: string, flake: string, configuration: string, format: MediaFormat, link_name: string): string {
  const nix = [shell_quote(settings.nix_bin), ...settings.nix_args.map(shell_quote)].join(" ");
  const link = shell_quote(`${media_root_dir.replace(/\/+$/, "")}/${link_name}`);
  const record: MediaRecord = { flake, configuration, format };
  const lines = [
    `# ${media_record_mark} ${JSON.stringify(record)}`,
    `if ! command -v ${shell_quote(settings.nix_bin)} >/dev/null 2>&1; then echo ${shell_quote(`${settings.nix_bin} is not on this host's PATH`)}; exit ${missing_tool_exit_code}; fi`,
    `mkdir -p ${shell_quote(media_root_dir)} || exit 1`,
    // A flake named by path or branch is not locked, which getFlake only reads when impure.
    `${nix} build --impure --print-build-logs --out-link ${link} --expr ${shell_quote(media_expression(flake, configuration, format))} || exit $?`,
    `echo "${media_mark} $(readlink -f ${link})"`,
  ];
  return lines.join("\n");
}

// What a media build's command says it builds, or null when it holds no record.
export function parse_media_record(command: string): MediaRecord | null {
  return parse_record<MediaRecord>(command, media_record_mark);
}

// The store path a media build printed, or null when it printed none.
export function parse_media_path(output: string): string | null {
  const line = output.split("\n").filter((text) => text.startsWith(`${media_mark} `)).pop();
  return line === undefined ? null : line.slice(media_mark.length + 1).trim() || null;
}
