/**
 * The text a quota row shows, kept out of `client/quota.tsx` on purpose: this module imports
 * nothing, so the branching edge cases (no reset time, an unparseable one, a reset already in the
 * past, minutes vs hours vs days) are unit-tested by `client/quota-format.test.ts`. A test cannot
 * import the component: `react-native` is Flow-typed and no vitest transform in this repo parses it.
 */

/**
 * Rounded minutes until `resetTime`, the single value both the visible and the spoken reset text
 * are built from. `null` when `agy` reported no time (`""`) or one `Date.parse` cannot read;
 * `"past"` when the reset has already happened, which a cached answer can outlive.
 */
function resetRemaining(resetTime: string, now: number): number | "past" | null {
  const text = resetTime.trim();
  if (text === "") return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const remainingMs = at - now;
  if (remainingMs <= 0) return "past";
  // A reset under a minute away is still a reset ahead, never "resets in 0m".
  return Math.max(1, Math.round(remainingMs / 60_000));
}

/** "resets in 42m" — "" when `agy` gave no usable time, "resetting now" when it has passed. */
export function formatResetIn(resetTime: string, now: number): string {
  const remaining = resetRemaining(resetTime, now);
  if (remaining === null) return "";
  if (remaining === "past") return "resetting now";
  return `resets in ${formatMinutes(remaining)}`;
}

/** The same phrase spelled out, for an accessibility label: "resets in 2 days 22 hours". */
export function formatResetInLong(resetTime: string, now: number): string {
  const remaining = resetRemaining(resetTime, now);
  if (remaining === null) return "";
  if (remaining === "past") return "resetting now";
  return `resets in ${formatMinutesLong(remaining)}`;
}

/** "42m" / "3h 5m" / "2d 22h"; a zero lower unit is left off ("2h", "2d"). */
function formatMinutes(total: number): string {
  if (total < 60) return `${total}m`;
  if (total < 24 * 60) {
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** "42 minutes" / "3 hours 5 minutes" / "2 days 22 hours". */
function formatMinutesLong(total: number): string {
  if (total < 60) return plural(total, "minute");
  if (total < 24 * 60) {
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes === 0
      ? plural(hours, "hour")
      : `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
  }
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  return hours === 0 ? plural(days, "day") : `${plural(days, "day")} ${plural(hours, "hour")}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "checked 14:05", the local clock time of the answer. */
export function formatCheckedAt(fetchedAt: number): string {
  const at = new Date(fetchedAt);
  if (Number.isNaN(at.getTime())) return "";
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * The window half of a row's title. `agy` names the pools itself ("5h", "weekly", "3p weekly"), so
 * only the two the plan calls out are spelled out; anything else is shown as the CLI wrote it, or
 * as the bucket's own name when the window is empty.
 */
export function windowLabel(window: string, bucketName: string): string {
  const text = window.trim();
  const normalized = text.toLowerCase();
  if (normalized === "5h") return "5-hour";
  if (normalized === "weekly") return "Weekly";
  return text === "" ? bucketName : text;
}

/** 0..100, rounded: `agy` reports a 0..1 share, and a bar cannot be wider than its track. */
export function percentLeft(remainingFraction: number): number {
  const percent = Math.round(remainingFraction * 100);
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** "Gemini Models weekly: 45 percent left, resets in 2 days 22 hours". */
export function bucketAccessibilityLabel(
  group: string,
  windowText: string,
  percent: number,
  resetLong: string,
): string {
  const head = `${group} ${windowText.toLowerCase()}: ${percent} percent left`;
  return resetLong === "" ? head : `${head}, ${resetLong}`;
}
