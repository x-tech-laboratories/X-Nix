// Live build progress, as nix-output-monitor shows it: reads the JSON lines `nix build --log-format internal-json` prints,
// turns them back into readable log lines, and keeps count of the derivations building and built and the paths
// downloading and downloaded. The counts are kept with the job, so they survive a restart of the server.

// ── Shapes ───────────────────────────────────────────────────────────────────

// Nix's activity and result types, from its logging.hh.
const activity_types = { copy_path: 100, copy_paths: 103, builds: 104, build: 105, substitute: 108 } as const;
const result_types = { build_log_line: 101, set_phase: 104, progress: 105, set_expected: 106, post_build_log_line: 107 } as const;

// The most verbose message level shown: info, as nix prints without -v.
const shown_level = 3;

export interface Activity {
  type: number;
  name: string;
  phase: string | null;
}

export interface BuildProgress {
  // Builds and downloads that have ended, whether or not they succeeded.
  builds_done: number;
  builds_failed: number;
  builds_expected: number | null;
  downloads_done: number;
  downloads_expected: number | null;
  // What is going on now, by nix's activity id; only builds and downloads are kept.
  activities: Record<string, Activity>;
  // The ids of the activities whose progress counts the whole build's builds or downloads.
  totals: Record<string, "builds" | "downloads">;
  // The start of a line not yet ended by a newline.
  carry: string;
}

export function empty_progress(): BuildProgress {
  return { builds_done: 0, builds_failed: 0, builds_expected: null, downloads_done: 0, downloads_expected: null, activities: {}, totals: {}, carry: "" };
}

interface NixLine {
  action?: string;
  id?: number;
  type?: number;
  level?: number;
  msg?: string;
  text?: string;
  fields?: unknown[];
}

// ── Reading ──────────────────────────────────────────────────────────────────

// Reads a piece of output into the progress, answering with the readable lines it stands for; ended flushes a last line.
export function read_build_log(progress: BuildProgress, chunk: string, ended: boolean): string {
  const text = progress.carry + chunk;
  const lines = text.split("\n");
  progress.carry = ended ? "" : lines.pop()!;
  const readable: string[] = [];
  for (const line of lines) {
    if (line === "") continue;
    const shown = read_line(progress, line);
    if (shown !== null) readable.push(shown);
  }
  // Nothing runs once the build has ended, whatever nix last reported.
  if (ended) progress.activities = {};
  return readable.length === 0 ? "" : `${readable.join("\n")}\n`;
}

function read_line(progress: BuildProgress, line: string): string | null {
  if (!line.startsWith("@nix ")) return line;
  let entry: NixLine;
  try {
    entry = JSON.parse(line.slice(5)) as NixLine;
  } catch {
    return line;
  }
  const fields = Array.isArray(entry.fields) ? entry.fields : [];
  const id = String(entry.id ?? "");
  switch (entry.action) {
    case "msg": {
      const message = strip_colours(entry.msg ?? "");
      if ((entry.level ?? 0) > shown_level) return null;
      if (/builder for '.+?' failed|Cannot build '.+?'/.test(message)) progress.builds_failed += 1;
      return message;
    }
    case "start": {
      if (entry.type === activity_types.build) progress.activities[id] = { type: entry.type, name: derivation_name(String(fields[0] ?? entry.text ?? "")), phase: null };
      else if (entry.type === activity_types.substitute) progress.activities[id] = { type: entry.type, name: path_name(String(fields[0] ?? entry.text ?? "")), phase: null };
      else if (entry.type === activity_types.builds) progress.totals[id] = "builds";
      else if (entry.type === activity_types.copy_paths) progress.totals[id] = "downloads";
      return null;
    }
    case "stop": {
      const activity = progress.activities[id];
      if (activity === undefined) return null;
      if (activity.type === activity_types.build) progress.builds_done += 1;
      else progress.downloads_done += 1;
      delete progress.activities[id];
      return null;
    }
    case "result":
      return read_result(progress, id, entry.type ?? 0, fields);
    default:
      return null;
  }
}

function read_result(progress: BuildProgress, id: string, type: number, fields: unknown[]): string | null {
  const activity = progress.activities[id];
  if (type === result_types.build_log_line || type === result_types.post_build_log_line) {
    const text = strip_colours(String(fields[0] ?? ""));
    return activity === undefined ? text : `${activity.name}> ${text}`;
  }
  if (type === result_types.set_phase && activity !== undefined) {
    activity.phase = String(fields[0] ?? "") || null;
    return null;
  }
  // Nix reports the whole build's expected counts on its builds and copy-paths activities.
  if (type === result_types.progress && typeof fields[1] === "number") {
    if (progress.totals[id] === "builds") progress.builds_expected = fields[1];
    else if (progress.totals[id] === "downloads") progress.downloads_expected = fields[1];
    return null;
  }
  if (type === result_types.set_expected && typeof fields[1] === "number") {
    if (fields[0] === activity_types.build) progress.builds_expected = fields[1];
    else if (fields[0] === activity_types.copy_path) progress.downloads_expected = fields[1];
  }
  return null;
}

// ── Summaries ────────────────────────────────────────────────────────────────

// One line for the job's progress, such as `Built 3 of 12, building 2; downloaded 40 of 140, downloading 4`.
export function summarise(progress: BuildProgress): string {
  const running = Object.values(progress.activities);
  const building = running.filter((activity) => activity.type === activity_types.build).length;
  const downloading = running.length - building;
  const built = Math.max(0, progress.builds_done - progress.builds_failed);
  const of = (expected: number | null) => (expected === null ? "" : ` of ${expected}`);
  const parts = [
    `Built ${built}${of(progress.builds_expected)}${building > 0 ? `, building ${building}` : ""}${progress.builds_failed > 0 ? `, ${progress.builds_failed} failed` : ""}`,
    `downloaded ${progress.downloads_done}${of(progress.downloads_expected)}${downloading > 0 ? `, downloading ${downloading}` : ""}`,
  ];
  return parts.join("; ");
}

export function is_build_activity(activity: Activity): boolean {
  return activity.type === activity_types.build;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// A derivation's name without its hash and .drv, such as `hello-2.12`.
function derivation_name(path: string): string {
  return path_name(path).replace(/\.drv$/, "");
}

function path_name(path: string): string {
  const base = path.split("/").pop() ?? path;
  return /^[0-9a-z]{32}-/.test(base) ? base.slice(33) : base;
}

function strip_colours(text: string): string {
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "");
}
