// Reads durations such as "2h30m" from the config and writes them back in words.

export { parse_duration } from "../shared/durations.ts";

const unit_names: [seconds: number, name: string][] = [
  [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"],
];

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
