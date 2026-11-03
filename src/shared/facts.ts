// What an agent's reads answer, as JSON on the run's stdout, shared by the agent that gathers it and the server.

// ── Probe ────────────────────────────────────────────────────────────────────

// The parts of a system closure whose change means the new one is only fully live after a reboot.
export const boot_parts = ["initrd", "kernel", "kernel-modules", "systemd"] as const;

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

// The generation number of a `system-210-link` profile link.
export function generation_of(profile_link: string): number | null {
  const name = profile_link.split("/").pop() ?? "";
  const match = /^system-(\d+)-link$/.exec(name);
  return match ? Number(match[1]) : null;
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface Profile {
  path: string;
  // The generation the profile points at.
  generation: number | null;
  count: number;
  oldest_epoch: number | null;
}

export interface GcFields {
  hostname: string | null;
  // The store's filesystem, in bytes; null when it could not be read.
  size_bytes: number | null;
  used_bytes: number | null;
  avail_bytes: number | null;
  paths: number | null;
  roots: number | null;
  svc_state: string;
  svc_result: string;
  svc_exit: string;
  timer_load: string;
  timer_state: string;
  timer_next: string;
  // The journal's last summary, outcome and error lines of the collection unit, as `journalctl -o short-unix` prints them.
  summary: string;
  outcome: string;
  error: string;
  profiles: Profile[];
}

// ── Boot ─────────────────────────────────────────────────────────────────────

export type Loader = "systemd-boot" | "grub" | "efi" | "none";

export interface BootEntry {
  id: string;
  title: string;
  default: boolean;
  next: boolean;
}

export interface Boot {
  loader: Loader;
  entries: BootEntry[];
  default: string | null;
  next: string | null;
  // grub-reboot or grub2-reboot, for GRUB.
  reboot_tool?: string;
}

// ── Generations ──────────────────────────────────────────────────────────────

// One generation of the system profile.
export interface Generation {
  generation: number;
  created_epoch: number | null;
  path: string;
  version: string | null;
  current: boolean;
  booted: boolean;
  // Whether the system profile points at it, so it is the default boot entry.
  profile: boolean;
}

// ── Products ─────────────────────────────────────────────────────────────────

export interface BuildProduct {
  type: string;
  subtype: string;
  path: string;
  name: string;
  // Null when it is not a regular file inside the store path, so it cannot be downloaded.
  size_bytes: number | null;
}

// A product's real path and size.
export interface LocatedFile {
  path: string;
  size: number;
}

// ── Reading ──────────────────────────────────────────────────────────────────

// The JSON a read printed, or null when it printed none.
export function read_facts<Shape>(stdout: string): Shape | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === "object" && value !== null ? (value as Shape) : null;
  } catch {
    return null;
  }
}
