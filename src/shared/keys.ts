// The rules a key X-Nix uploads must keep, shared by the server's config and the agent that writes it: a plain path
// under /run/keys, an account name for its owner and group, and permission bits for its mode.

// ── Rules ────────────────────────────────────────────────────────────────────

// The folder every key lives under, which NixOS keeps in memory.
export const key_folder = "/run/keys";

// Whether the path is a plain file path under /run/keys, with no step back up and nothing a shell would read.
export function is_key_destination(path: string): boolean {
  if (!path.startsWith(`${key_folder}/`) || path.includes("..")) return false;
  const steps = path.slice(key_folder.length + 1).split("/");
  return steps.every((step) => /^[A-Za-z0-9_.@+-]+$/.test(step) && step !== "." && step !== "..");
}

// Whether the text is a user or group name as useradd takes it.
export function is_account_name(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*\$?$/.test(name) && name.length <= 32;
}

// Whether the text is permission bits such as 0400 or 640.
export function is_key_mode(mode: string): boolean {
  return /^0?[0-7]{3}$/.test(mode);
}

// ── Shapes ───────────────────────────────────────────────────────────────────

// One key to write, whose contents travel only inside this request.
export interface KeyWrite {
  destination: string;
  owner: string;
  group: string;
  mode: string;
  content_base64: string;
  // Whether the writer runs under `sudo -n`.
  sudo: boolean;
}

// A key as found on the host; its contents come back only as a hash salted by the server.
export interface KeyState {
  destination: string;
  present: boolean;
  salted_hash: string | null;
  size: number | null;
  owner: string | null;
  group: string | null;
  // The permission bits as stat prints them, such as 400.
  mode: string | null;
}
