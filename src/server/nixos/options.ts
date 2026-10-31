// The option and package lists of a deployment's own nixpkgs pin: the command that generates them on a host, what it
// prints, the compact entries kept in the state folder, and the search over them.
//
// The command builds the configuration's `system.build.manual.optionsJSON`, so the NixOS options include the flake's
// own modules; with a `home-manager` input it also builds that input's `docs-json`; and it runs `nix search` over the
// pinned nixpkgs unless its packages are already cached. It prints a marker line naming each file it made, which the
// server then fetches whole, gzipped, over one command.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeploymentSettings } from "../config.ts";
import { shell_quote } from "./commands.ts";
import { local_path } from "./flake.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type OptionSource = "nixos" | "home-manager";

export interface OptionEntry {
  name: string;
  source: OptionSource;
  type: string;
  default: string | null;
  example: string | null;
  description: string;
  declared_in: string[];
  read_only: boolean;
}

export interface PackageEntry {
  attribute: string;
  name: string;
  version: string;
  description: string;
}

// What a finished generation printed: the files it made and the pin they came from.
export interface GeneratedFiles {
  folder: string | null;
  nixpkgs: string | null;
  revision: string | null;
  nixos: string | null;
  home_manager: string | null;
  // A file path, or "cached" when the pin's packages were already kept.
  packages: string | null;
}

export interface SearchAnswer<Entry> {
  total: number;
  entries: Entry[];
}

// Starts each line that names what the generation made.
export const options_mark = "@@x-nix-options";

// ── Helpers ──────────────────────────────────────────────────────────────────

function nix(settings: DeploymentSettings): string {
  return [settings.nix_bin, ...settings.nix_args.map(shell_quote)].join(" ");
}

function escape_double_quoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$");
}

// A Nix string literal holding the text.
export function nix_string(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${")}"`;
}

// An attribute under the configuration, double-quoted for sh, such as its `config.system.build.manual.optionsJSON`.
export function configuration_installable(settings: DeploymentSettings, attribute: string, path: string): string {
  return `"${escape_double_quoted(settings.flake)}#nixosConfigurations.\\"${escape_double_quoted(attribute)}\\".${path}"`;
}

function refresh(settings: DeploymentSettings): string {
  return local_path(settings.flake) === null ? " --refresh" : "";
}

// The key the pin's files are kept under: the hash of the nixpkgs source's store path.
export function nixpkgs_key(nixpkgs_path: string): string | null {
  const match = /^\/nix\/store\/([a-z0-9]{32})-/.exec(nixpkgs_path);
  return match === null ? null : match[1];
}

// ── Generating ───────────────────────────────────────────────────────────────

// Builds the option lists and searches the packages, printing a marker for each file; `cached_keys` skips the search.
export function options_command(settings: DeploymentSettings, attribute: string, timeout_in_seconds: number, cached_keys: string[]): string {
  const run = nix(settings);
  const evaluate = `${run} eval --raw --no-write-lock-file${refresh(settings)}`;
  const has_home_manager = `${run} eval --impure --expr ${shell_quote(`builtins.hasAttr "home-manager" (builtins.getFlake ${nix_string(settings.flake)}).inputs`)}`;
  const home_manager_docs = `${run} build --impure --no-link --print-out-paths --expr ${shell_quote(`(builtins.getFlake ${nix_string(settings.flake)}).inputs.home-manager.packages.\${builtins.currentSystem}.docs-json`)}`;
  const lines = [
    "set -u",
    "status=0",
    "w=$(mktemp -d -t x-nix-options.XXXXXX)",
    `echo "${options_mark} folder $w"`,
    `${evaluate} ${configuration_installable(settings, attribute, "pkgs.path")} > "$w/nixpkgs" || exit 1`,
    `echo "${options_mark} nixpkgs $(cat "$w/nixpkgs")"`,
    `if ${evaluate} ${configuration_installable(settings, attribute, "config.system.nixos.revision")} > "$w/revision" 2>/dev/null; then echo "${options_mark} revision $(cat "$w/revision")"; fi`,
    `system=$(${evaluate} ${configuration_installable(settings, attribute, "pkgs.stdenv.hostPlatform.system")}) || exit 1`,
    `if out=$(${run} build --no-link --print-out-paths --no-write-lock-file${refresh(settings)} ${configuration_installable(settings, attribute, "config.system.build.manual.optionsJSON")}); then`,
    `  echo "${options_mark} nixos $out/share/doc/nixos/options.json"`,
    "else echo 'Could not build the NixOS options; is documentation.nixos.enable off?'; status=1; fi",
    `if [ "$(${has_home_manager})" = true ]; then`,
    `  if out=$(${home_manager_docs}); then echo "${options_mark} home-manager $out/share/doc/home-manager/options.json"; else status=1; fi`,
    "fi",
    `key=$(basename "$(cat "$w/nixpkgs")" | cut -d - -f 1)`,
    `case " ${cached_keys.join(" ")} " in`,
    `  *" $key "*) echo "${options_mark} packages cached" ;;`,
    `  *) if ${run} search --json --no-write-lock-file "path:$(cat "$w/nixpkgs")#legacyPackages.$system" '^' > "$w/packages.json"; then echo "${options_mark} packages $w/packages.json"; else status=1; fi ;;`,
    "esac",
    "exit $status",
  ];
  return `timeout ${timeout_in_seconds} sh -c ${shell_quote(lines.join("\n"))}`;
}

// Reads the marker lines of a finished generation's output.
export function parse_generated(output: string): GeneratedFiles {
  const files: GeneratedFiles = { folder: null, nixpkgs: null, revision: null, nixos: null, home_manager: null, packages: null };
  for (const line of output.split("\n")) {
    if (!line.startsWith(`${options_mark} `)) continue;
    const [kind, ...rest] = line.slice(options_mark.length + 1).split(" ");
    const value = rest.join(" ").trim();
    if (value === "") continue;
    if (kind === "folder") files.folder = value;
    else if (kind === "nixpkgs") files.nixpkgs = value;
    else if (kind === "revision") files.revision = value;
    else if (kind === "nixos") files.nixos = value;
    else if (kind === "home-manager") files.home_manager = value;
    else if (kind === "packages") files.packages = value;
  }
  return files;
}

// Prints a file gzipped and in base64 on one line, so a large list travels as one command's output.
export function fetch_command(path: string): string {
  return `gzip -c ${shell_quote(path)} | base64 -w 0`;
}

// Removes the generation's own temporary folder, and nothing else.
export function cleanup_command(folder: string): string | null {
  if (!/^\/[\w./-]*\/x-nix-options\.[A-Za-z0-9]+$/.test(folder) || folder.includes("..")) return null;
  return `rm -rf ${shell_quote(folder)}`;
}

// ── Compacting ───────────────────────────────────────────────────────────────

// A default or example as its Nix text: a literal expression as written, anything else as JSON.
function value_text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record._type === "string" && typeof record.text === "string") return record.text;
  }
  return JSON.stringify(value);
}

function declaration_text(declaration: unknown): string | null {
  if (typeof declaration === "string") return declaration;
  if (typeof declaration === "object" && declaration !== null) {
    const record = declaration as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    if (typeof record.url === "string") return record.url;
  }
  return null;
}

// The entries of an options.json, sorted by name, leaving out the internal ones.
export function compact_options(raw: unknown, source: OptionSource): OptionEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const entries: OptionEntry[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const option = value as Record<string, unknown>;
    if (option.internal === true || option.visible === false) continue;
    entries.push({
      name,
      source,
      type: typeof option.type === "string" ? option.type : "unspecified",
      default: value_text(option.default),
      example: value_text(option.example),
      description: typeof option.description === "string" ? option.description.trim() : "",
      declared_in: (Array.isArray(option.declarations) ? option.declarations : []).map(declaration_text).filter((text): text is string => text !== null),
      read_only: option.readOnly === true,
    });
  }
  return entries.sort((first, second) => first.name.localeCompare(second.name));
}

// The packages `nix search --json` printed, by attribute without its legacyPackages.<system> prefix.
export function compact_packages(raw: unknown): PackageEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const entries: PackageEntry[] = [];
  for (const [attribute, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const found = value as Record<string, unknown>;
    entries.push({
      attribute: attribute.replace(/^legacyPackages\.[^.]+\./, ""),
      name: typeof found.pname === "string" ? found.pname : "",
      version: typeof found.version === "string" ? found.version : "",
      description: typeof found.description === "string" ? found.description : "",
    });
  }
  return entries.sort((first, second) => first.attribute.localeCompare(second.attribute));
}

// ── Searching ────────────────────────────────────────────────────────────────

// Ranks entries holding every word of the query: an exact name first, then a name ending in it, then names holding
// every word, then the rest, shorter names first within each.
export function search<Entry>(entries: Entry[], query: string, name_of: (entry: Entry) => string, text_of: (entry: Entry) => string, limit: number): SearchAnswer<Entry> {
  const wanted = query.trim().toLowerCase();
  const words = wanted.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { total: entries.length, entries: entries.slice(0, limit) };
  const ranked: [rank: number, entry: Entry][] = [];
  for (const entry of entries) {
    const name = name_of(entry).toLowerCase();
    const text = text_of(entry).toLowerCase();
    if (!words.every((word) => name.includes(word) || text.includes(word))) continue;
    let rank = 3;
    if (name === wanted) rank = 0;
    else if (name.endsWith(`.${wanted}`) || name.startsWith(wanted)) rank = 1;
    else if (words.every((word) => name.includes(word))) rank = 2;
    ranked.push([rank, entry]);
  }
  ranked.sort((first, second) => first[0] - second[0] || name_of(first[1]).length - name_of(second[1]).length);
  return { total: ranked.length, entries: ranked.slice(0, limit).map(([, entry]) => entry) };
}

// ── Values ───────────────────────────────────────────────────────────────────

// An option name's steps, or null for one with a placeholder such as <name> that names no single value.
export function option_path(name: string): string[] | null {
  const steps = name.split(".");
  return steps.every((step) => /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(step)) ? steps : null;
}

// Evaluates the option's value in the deployment's configuration as JSON.
export function value_command(settings: DeploymentSettings, attribute: string, steps: string[]): string {
  const path = ["config", ...steps].map((step) => `\\"${step}\\"`).join(".");
  return `${nix(settings)} eval --json --no-write-lock-file${refresh(settings)} ${configuration_installable(settings, attribute, path)}`;
}
