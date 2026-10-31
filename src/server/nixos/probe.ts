// The cheap facts read from a deployment's host every cycle: what is running, what was booted, and its generation.

// ── Boot parts ───────────────────────────────────────────────────────────────

// The parts of a system closure whose change means the new one is only fully live after a reboot.
export const boot_parts = ["initrd", "kernel", "kernel-modules", "systemd"] as const;

// Whether any booted part differs from the current one; null when the comparison could not be made.
export function reboot_required(booted: string[], current: string[]): boolean | null {
  if (booted.length === 0 || booted.length !== current.length || !booted.some(Boolean)) return null;
  return booted.some((path, index) => path !== current[index]);
}

// ── Probe ────────────────────────────────────────────────────────────────────

export interface ProbeFields {
  hostname: string | null;
  current: string | null;
  booted: string | null;
  switched_epoch: number | null;
  // When the running generation's profile link was made.
  profile_created_epoch: number | null;
  generation: number | null;
  version: string | null;
  booted_parts: string[];
  current_parts: string[];
}

export function probe_script(): string {
  return [
    'echo "hostname=$(uname -n)"',
    'echo "current=$(readlink -f /run/current-system 2>/dev/null)"',
    'echo "booted=$(readlink -f /run/booted-system 2>/dev/null)"',
    'echo "switched=$(stat -c %Y /run/current-system 2>/dev/null)"',
    'echo "profile=$(readlink /nix/var/nix/profiles/system 2>/dev/null)"',
    'echo "profile_created=$(stat -c %Y "/nix/var/nix/profiles/$(readlink /nix/var/nix/profiles/system)" 2>/dev/null)"',
    'echo "version=$(cat /run/current-system/nixos-version 2>/dev/null)"',
    "echo \"version_json=$(nixos-version --json 2>/dev/null | tr -d '\\n')\"",
    `for part in ${boot_parts.join(" ")}; do`,
    '  echo "booted_part=$(readlink -f /run/booted-system/$part 2>/dev/null)"',
    '  echo "current_part=$(readlink -f /run/current-system/$part 2>/dev/null)"',
    "done",
  ].join("\n");
}

export function parse_probe(stdout: string): ProbeFields {
  const values = new Map<string, string>();
  const booted_parts: string[] = [];
  const current_parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "booted_part") booted_parts.push(value);
    else if (key === "current_part") current_parts.push(value);
    else values.set(key, value);
  }
  const text = (key: string) => values.get(key) || null;
  const epoch = (key: string) => (/^\d+$/.test(values.get(key) ?? "") ? Number(values.get(key)) : null);
  return {
    hostname: text("hostname"),
    current: text("current"),
    booted: text("booted"),
    switched_epoch: epoch("switched"),
    profile_created_epoch: epoch("profile_created"),
    generation: generation_of(values.get("profile") ?? ""),
    version: text("version") ?? version_from_json(values.get("version_json") ?? ""),
    booted_parts,
    current_parts,
  };
}

// The generation number of a `system-210-link` profile link.
export function generation_of(profile_link: string): number | null {
  const name = profile_link.split("/").pop() ?? "";
  const match = /^system-(\d+)-link$/.exec(name);
  return match ? Number(match[1]) : null;
}

function version_from_json(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { nixosVersion?: unknown };
    return typeof data.nixosVersion === "string" ? data.nixosVersion : null;
  } catch {
    return null;
  }
}
