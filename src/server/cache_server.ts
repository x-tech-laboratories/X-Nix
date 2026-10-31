// The cache server's own health and size: its `/nix-cache-info`, and the `/health` and Prometheus `/metrics` endpoints an
// Attic or Harmonia server may offer. The X-Nix server fetches each configured URL itself every cycle, and the cache's
// page shows what they answered with a status of its own, apart from the targets' status.

// ── Imports ──────────────────────────────────────────────────────────────────

import { worse, type CacheSettings, type Status } from "./config.ts";
import type { Message } from "./deployment.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface MetricSample {
  // The metric's name with its labels, as the server printed them.
  name: string;
  value: number;
}

export interface CacheServerReading {
  status: Status;
  checked_epoch: number;
  messages: Message[];
  // The fields of `/nix-cache-info`, such as StoreDir and Priority; null when it was not read.
  info: Record<string, string> | null;
  // Whether `/health` answered with success; null when it is not asked.
  healthy: boolean | null;
  // The sum of `size_metric`'s samples; null when there is none.
  size_bytes: number | null;
  // The samples of byte-sized metrics and of `size_metric`.
  metrics: MetricSample[];
}

// How the server fetches a URL; tests pass their own.
export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const fetch_timeout_in_milliseconds = 10_000;

// The page lists at most this many metric samples.
const metrics_shown = 20;

// ── Parsing ──────────────────────────────────────────────────────────────────

// The `Key: value` lines of a nix-cache-info file.
export function parse_cache_info(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (match !== null) fields[match[1]] = match[2];
  }
  return fields;
}

// Every sample of a Prometheus text exposition, skipping comments and lines it cannot read.
export function parse_metrics(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*(?:\{[^}]*\})?)\s+(\S+)/.exec(trimmed);
    if (match === null) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) samples.push({ name: match[1], value });
  }
  return samples;
}

// The metric's name without its labels.
function bare_name(sample: MetricSample): string {
  const brace = sample.name.indexOf("{");
  return brace === -1 ? sample.name : sample.name.slice(0, brace);
}

// ── Probing ──────────────────────────────────────────────────────────────────

// Whether the cache names any endpoint to read.
export function has_server_urls(settings: CacheSettings): boolean {
  return settings.info_url !== null || settings.health_url !== null || settings.metrics_url !== null;
}

async function fetch_text(fetcher: Fetcher, url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(fetch_timeout_in_milliseconds) });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `${url} answered ${response.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}` };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: `Could not reach ${url}: ${(error as Error).message}` };
  }
}

// Reads every configured endpoint at once and judges them, or answers null when the cache names none.
export async function probe_cache_server(settings: CacheSettings, fetcher: Fetcher, now: number): Promise<CacheServerReading | null> {
  if (!has_server_urls(settings)) return null;
  const skipped = Promise.resolve(null);
  const [info, health, metrics] = await Promise.all([
    settings.info_url === null ? skipped : fetch_text(fetcher, settings.info_url),
    settings.health_url === null ? skipped : fetch_text(fetcher, settings.health_url),
    settings.metrics_url === null ? skipped : fetch_text(fetcher, settings.metrics_url),
  ]);
  const reading: CacheServerReading = { status: "online", checked_epoch: now, messages: [], info: null, healthy: null, size_bytes: null, metrics: [] };
  const fail = (text: string) => {
    reading.status = worse(reading.status, settings.server_status);
    reading.messages.push({ level: settings.server_status === "failed" ? "error" : "warning", text });
  };

  if (info !== null) {
    if (info.ok) {
      reading.info = parse_cache_info(info.text);
      if (reading.info.StoreDir === undefined) fail(`${settings.info_url} is not a nix-cache-info file`);
      else reading.messages.push({ level: "info", text: `Serves ${reading.info.StoreDir}${reading.info.Priority ? ` at priority ${reading.info.Priority}` : ""}` });
    } else fail(info.error);
  }
  if (health !== null) {
    reading.healthy = health.ok;
    if (health.ok) reading.messages.push({ level: "info", text: "Reports itself healthy" });
    else fail(`Not healthy: ${health.error}`);
  }
  if (metrics !== null) {
    if (metrics.ok) {
      const samples = parse_metrics(metrics.text);
      const sized = samples.filter((sample) => bare_name(sample) === settings.size_metric);
      if (sized.length > 0) reading.size_bytes = sized.reduce((sum, sample) => sum + sample.value, 0);
      else if (settings.size_metric !== null) reading.messages.push({ level: "info", text: `${settings.metrics_url} has no ${settings.size_metric}` });
      reading.metrics = samples.filter((sample) => bare_name(sample) === settings.size_metric || bare_name(sample).endsWith("_bytes")).slice(0, metrics_shown);
    } else fail(metrics.error);
  }
  return reading;
}
