// Reads durations such as "2h30m" from the config and writes them back in words.

const unit_seconds: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

const unit_names: [seconds: number, name: string][] = [
  [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"],
];

export function parse_duration(value: unknown, key: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  const text = String(value).trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^(\d+[wdhms])+$/.test(text)) throw new Error(`\`${key}\` must be a duration such as "1w", "7d", "2h30m" or "60s", not ${JSON.stringify(value)}`);
  let seconds = 0;
  for (const [, count, unit] of text.matchAll(/(\d+)([wdhms])/g)) seconds += Number(count) * unit_seconds[unit];
  return seconds;
}

// The two largest whole units, such as "1 day 2 hours".
export function format_duration(seconds: number): string {
  if (seconds <= 0) return "0 seconds";
  const parts: string[] = [];
  let remaining = Math.floor(seconds);
  for (const [size, name] of unit_names) {
    if (remaining < size) continue;
    const count = Math.floor(remaining / size);
    remaining %= size;
    parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
  }
  return parts.slice(0, 2).join(" ");
}

export function format_age(seconds: number): string {
  return seconds < 0 ? "never" : `${format_duration(seconds)} ago`;
}
