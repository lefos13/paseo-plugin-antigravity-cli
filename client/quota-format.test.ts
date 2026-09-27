import { describe, expect, it } from "vitest";
import {
  bucketAccessibilityLabel,
  formatCheckedAt,
  formatResetIn,
  formatResetInLong,
  percentLeft,
  windowLabel,
} from "./quota-format";

/**
 * The reset countdown is the only branching text on a quota row (no time, unreadable time, past,
 * minutes, hours, days), so it is the part tested in isolation. `client/quota.tsx` itself cannot be
 * imported here: it pulls in `react-native`, which no vitest transform in this repo parses.
 */

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

/** An RFC3339 timestamp `ms` away from `NOW`, as `agy` reports `reset_time`. */
function resetAt(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatResetIn", () => {
  it("renders nothing when agy reported no reset time", () => {
    expect(formatResetIn("", NOW)).toBe("");
    expect(formatResetIn("   ", NOW)).toBe("");
  });

  it("renders nothing for a time this client cannot parse", () => {
    expect(formatResetIn("soon", NOW)).toBe("");
    expect(formatResetIn("2026-13-45T99:00:00Z", NOW)).toBe("");
  });

  it("says resetting now once the reset has passed or is happening", () => {
    expect(formatResetIn(resetAt(-MINUTE), NOW)).toBe("resetting now");
    expect(formatResetIn(resetAt(0), NOW)).toBe("resetting now");
  });

  it("counts minutes under an hour, never zero", () => {
    expect(formatResetIn(resetAt(42 * MINUTE), NOW)).toBe("resets in 42m");
    expect(formatResetIn(resetAt(59 * MINUTE), NOW)).toBe("resets in 59m");
    expect(formatResetIn(resetAt(30_000), NOW)).toBe("resets in 1m");
  });

  it("counts hours and minutes under a day, dropping an empty minute part", () => {
    expect(formatResetIn(resetAt(HOUR + 60_000), NOW)).toBe("resets in 1h 1m");
    expect(formatResetIn(resetAt(3 * HOUR + 5 * MINUTE), NOW)).toBe("resets in 3h 5m");
    expect(formatResetIn(resetAt(2 * HOUR), NOW)).toBe("resets in 2h");
    expect(formatResetIn(resetAt(23 * HOUR + 59 * MINUTE), NOW)).toBe("resets in 23h 59m");
  });

  it("counts days above a day, dropping an empty hour part", () => {
    expect(formatResetIn(resetAt(2 * DAY + 22 * HOUR), NOW)).toBe("resets in 2d 22h");
    expect(formatResetIn(resetAt(2 * DAY + 23 * HOUR + 59 * MINUTE), NOW)).toBe("resets in 2d 23h");
    expect(formatResetIn(resetAt(3 * DAY), NOW)).toBe("resets in 3d");
  });

  it("rounds to the nearest minute without crossing a unit", () => {
    // 59m 40s must not become "resets in 60m".
    expect(formatResetIn(resetAt(HOUR - 20_000), NOW)).toBe("resets in 1h");
  });
});

describe("formatResetInLong", () => {
  it("spells the countdown out for a screen reader", () => {
    expect(formatResetInLong(resetAt(2 * DAY + 22 * HOUR), NOW)).toBe(
      "resets in 2 days 22 hours",
    );
    expect(formatResetInLong(resetAt(HOUR + MINUTE), NOW)).toBe("resets in 1 hour 1 minute");
    expect(formatResetInLong(resetAt(42 * MINUTE), NOW)).toBe("resets in 42 minutes");
  });

  it("agrees with the short form on the cases without a duration", () => {
    expect(formatResetInLong("", NOW)).toBe("");
    expect(formatResetInLong(resetAt(-MINUTE), NOW)).toBe("resetting now");
  });
});

describe("windowLabel", () => {
  it("spells out the two windows the plan names, ignoring case", () => {
    expect(windowLabel("5h", "Five hours")).toBe("5-hour");
    expect(windowLabel("5H", "Five hours")).toBe("5-hour");
    expect(windowLabel("weekly", "Weekly")).toBe("Weekly");
    expect(windowLabel("Weekly", "Weekly")).toBe("Weekly");
  });

  it("keeps any other window as agy wrote it, falling back to the bucket name", () => {
    expect(windowLabel("3p weekly", "Weekly")).toBe("3p weekly");
    expect(windowLabel("monthly", "Monthly")).toBe("monthly");
    expect(windowLabel("   ", "Gemini Pro")).toBe("Gemini Pro");
  });
});

describe("percentLeft", () => {
  it("rounds the 0..1 share and clamps it to a bar's width", () => {
    expect(percentLeft(0.45)).toBe(45);
    expect(percentLeft(0.999)).toBe(100);
    expect(percentLeft(1.2)).toBe(100);
    expect(percentLeft(-0.2)).toBe(0);
    expect(percentLeft(Number.NaN)).toBe(0);
  });
});

describe("formatCheckedAt", () => {
  it("prints the local wall clock, zero padded", () => {
    expect(formatCheckedAt(new Date(2026, 8, 27, 9, 5).getTime())).toBe("09:05");
    expect(formatCheckedAt(new Date(2026, 8, 27, 14, 30).getTime())).toBe("14:30");
  });

  it("prints nothing for a time it cannot read", () => {
    expect(formatCheckedAt(Number.NaN)).toBe("");
  });
});

describe("bucketAccessibilityLabel", () => {
  it("reads the row's own words, in order", () => {
    expect(
      bucketAccessibilityLabel("Gemini Models", "Weekly", 45, "resets in 2 days 22 hours"),
    ).toBe("Gemini Models weekly: 45 percent left, resets in 2 days 22 hours");
  });

  it("leaves the reset clause out when agy reported no reset time", () => {
    expect(bucketAccessibilityLabel("Gemini Models", "5-hour", 99, "")).toBe(
      "Gemini Models 5-hour: 99 percent left",
    );
  });
});
