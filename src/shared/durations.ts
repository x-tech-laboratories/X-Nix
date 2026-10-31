// Reads durations such as "2h30m" from settings, for the server and the agent alike.

const unit_seconds: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

export function parse_duration(value: unknown, key: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  const text = String(value).trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^(\d+[wdhms])+$/.test(text)) throw new Error(`\`${key}\` must be a duration such as "1w", "7d", "2h30m" or "60s", not ${JSON.stringify(value)}`);
  let seconds = 0;
  for (const [, count, unit] of text.matchAll(/(\d+)([wdhms])/g)) seconds += Number(count) * unit_seconds[unit];
  return seconds;
}
