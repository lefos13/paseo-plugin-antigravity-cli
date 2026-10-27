import { describe, expect, it, vi } from "vitest";
import type { UsageScope, UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";
import type { Account, AccountsState } from "./accounts";
import type { QuotaResult } from "./quota";
import {
  createUsageSource,
  reportFromQuota,
  usageAccountKey,
  usageInputSchema,
  type UsageSourceOptions,
} from "./usage";

/**
 * The usage source is the SDK's read of the plugin's existing quota cache. These tests never spawn
 * `agy`: the account and quota readers are injected, so every state of `QuotaResult` is covered
 * without a login store.
 */

const ACCOUNTS: Account[] = [
  { id: "default", name: "Default" },
  { id: "work", name: "Work" },
];

const SHADOW_HOME = "/paseo/plugin-data/antigravity-cli/accounts/work/home";
const REAL_HOME = "/home/ada";

function options(overrides: Partial<UsageSourceOptions> = {}): UsageSourceOptions {
  return {
    listAccounts: () => ACCOUNTS,
    readAccounts: (): AccountsState => ({
      active: "work",
      accounts: ACCOUNTS.filter((account) => account.id !== "default"),
    }),
    accountHome: (id) => (id === "work" ? SHADOW_HOME : null),
    homeDir: () => REAL_HOME,
    readQuota: async () => ({ state: "ok", fetchedAt: 0, groups: [] }),
    ...overrides,
  };
}

function session(env: Record<string, string>, provider = "antigravity-cli"): UsageScope {
  return { kind: "session", provider, env };
}

// Whole percents, as the plugin's own quota screen shows them (`client/quota-format.ts`).
const WEEKLY_USED = 55;
const THIRD_PARTY_USED = 13;

const OK_QUOTA: QuotaResult = {
  state: "ok",
  fetchedAt: 1_700_000_000_000,
  groups: [
    {
      name: "Gemini Models",
      buckets: [
        {
          id: "gemini-weekly",
          name: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: 0.4486817717552185,
          resetTime: "2026-09-30T09:43:54Z",
        },
        {
          id: "gemini-5h",
          name: "Five Hour Limit Remaining",
          window: "5h",
          remainingFraction: 1,
          resetTime: "",
        },
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: [
        {
          id: "3p-weekly",
          name: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: 0.8659847974777222,
          resetTime: "2026-09-30T14:42:32Z",
        },
      ],
    },
  ],
};

describe("reportFromQuota", () => {
  it("maps every bucket to a window and marks the first group's windows for the summary", () => {
    const report = reportFromQuota(OK_QUOTA);

    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "Gemini Models/gemini-weekly",
          label: "Gemini Models · Weekly",
          shortLabel: "wk",
          summary: true,
          usedPct: WEEKLY_USED,
          remainingPct: 100 - WEEKLY_USED,
          resetsAt: "2026-09-30T09:43:54Z",
          tone: "ok",
        },
        {
          id: "Gemini Models/gemini-5h",
          label: "Gemini Models · 5-hour",
          shortLabel: "5h",
          summary: true,
          usedPct: 0,
          remainingPct: 100,
          // agy had no reset time for this bucket; the window must say "unknown", not "".
          resetsAt: null,
          tone: "ok",
        },
        {
          id: "Claude and GPT models/3p-weekly",
          label: "Claude and GPT models · Weekly",
          shortLabel: "wk",
          usedPct: THIRD_PARTY_USED,
          remainingPct: 100 - THIRD_PARTY_USED,
          resetsAt: "2026-09-30T14:42:32Z",
          tone: "ok",
        },
      ],
    });
  });

  it("marks the first group that actually reported a window", () => {
    const report = reportFromQuota({
      state: "ok",
      fetchedAt: 0,
      groups: [
        { name: "Empty", buckets: [] },
        {
          name: "Only",
          buckets: [
            {
              id: "weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-01T00:00:00Z",
            },
          ],
        },
      ],
    });

    expect(report).toMatchObject({
      status: "available",
      windows: [{ id: "Only/weekly", summary: true }],
    });
  });

  it("uses agy's window names and bucket names for the label and short label", () => {
    const report = reportFromQuota({
      state: "ok",
      fetchedAt: 0,
      groups: [
        {
          name: "",
          buckets: [
            {
              id: "unknown",
              name: "Some Limit",
              window: "daily",
              remainingFraction: 0.5,
              resetTime: "",
            },
          ],
        },
      ],
    });

    expect(report).toMatchObject({
      status: "available",
      windows: [{ id: "unknown", label: "daily", shortLabel: "daily" }],
    });
  });

  it("uses the SDK tone thresholds for the used share", () => {
    const report = reportFromQuota({
      state: "ok",
      fetchedAt: 0,
      groups: [
        {
          name: "Limits",
          buckets: [
            { id: "ok", name: "A", window: "5h", remainingFraction: 0.95, resetTime: "" },
            { id: "warning", name: "B", window: "5h", remainingFraction: 0.25, resetTime: "" },
            { id: "danger", name: "C", window: "5h", remainingFraction: 0.05, resetTime: "" },
          ],
        },
      ],
    });

    expect(report).toMatchObject({
      status: "available",
      windows: [
        { id: "Limits/ok", usedPct: 5, tone: "ok" },
        { id: "Limits/warning", usedPct: 75, tone: "warning" },
        { id: "Limits/danger", usedPct: 95, tone: "danger" },
      ],
    });
  });

  it("shows an ok answer with no buckets as available and empty", () => {
    expect(reportFromQuota({ state: "ok", fetchedAt: 0, groups: [] })).toEqual({
      status: "available",
      windows: [],
    });
  });

  it("maps a signed-out account to a rejected login so the UI offers sign-in", () => {
    expect(reportFromQuota({ state: "signed-out" })).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401 },
    });
  });

  it("maps an account without quota to agy's own explanation", () => {
    expect(
      reportFromQuota({
        state: "unavailable",
        message: "no quota summary is available for this account",
      }),
    ).toEqual({
      status: "unavailable",
      problem: {
        kind: "no_quota",
        detail: "no quota summary is available for this account",
      },
    });
  });

  it("maps an unexpected answer to an error with agy's message", () => {
    expect(reportFromQuota({ state: "error", message: "agy (agy) did not answer /usage with JSON" })).toEqual({
      status: "error",
      error: "agy (agy) did not answer /usage with JSON",
    });
  });
});

describe("account keys", () => {
  it("keeps an id that already fits the SDK's key rule", () => {
    expect(usageAccountKey("work")).toBe("work");
    expect(usageAccountKey("default")).toBe("default");
  });

  it("hashes an id that does not fit, so the key is always legal and never a credential", () => {
    const key = usageAccountKey("Ada Lovelace");

    expect(key).toBe(hashAccountKey("Ada Lovelace"));
    expect(key).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });
});

describe("discover", () => {
  it("returns every configured account for the global scope", async () => {
    const source = createUsageSource(options());

    expect(await source.discover({ kind: "global" })).toEqual([
      { key: "default", label: "Default", harness: "Antigravity", input: { accountId: "default" } },
      { key: "work", label: "Work", harness: "Antigravity", input: { accountId: "work" } },
    ]);
  });

  it("hashes a non-conforming account id into the key while keeping the real id in input", async () => {
    const source = createUsageSource(
      options({ listAccounts: () => [{ id: "Ada Lovelace", name: "Ada" }] }),
    );

    expect(await source.discover({ kind: "global" })).toEqual([
      {
        key: hashAccountKey("Ada Lovelace"),
        label: "Ada",
        harness: "Antigravity",
        input: { accountId: "Ada Lovelace" },
      },
    ]);
  });

  it("returns nothing for a session owned by another provider", async () => {
    const source = createUsageSource(options());

    expect(await source.discover(session({ HOME: SHADOW_HOME }, "claude"))).toEqual([]);
  });

  it("returns the account whose shadow home is the session's HOME", async () => {
    const source = createUsageSource(options());

    expect(await source.discover(session({ HOME: SHADOW_HOME }))).toEqual([
      { key: "work", label: "Work", harness: "Antigravity", input: { accountId: "work" } },
    ]);
  });

  it("returns Default when the session runs in the real home", async () => {
    const source = createUsageSource(options());

    expect(await source.discover(session({ HOME: REAL_HOME }))).toEqual([
      { key: "default", label: "Default", harness: "Antigravity", input: { accountId: "default" } },
    ]);
  });

  it("falls back to the active account when the environment does not identify one", async () => {
    const source = createUsageSource(options());

    expect(await source.discover(session({}))).toEqual([
      { key: "work", label: "Work", harness: "Antigravity", input: { accountId: "work" } },
    ]);
  });

  it("returns nothing when the active account is no longer configured", async () => {
    const source = createUsageSource(
      options({
        readAccounts: () => ({ active: "gone", accounts: [] }),
      }),
    );

    expect(await source.discover(session({}))).toEqual([]);
  });
});

describe("fetch", () => {
  it("reads the account through the existing cache reader", async () => {
    const readQuota = vi.fn(async () => OK_QUOTA);
    const source = createUsageSource(options({ readQuota }));

    await expect(source.fetch({ accountId: "work" })).resolves.toMatchObject({
      status: "available",
    });
    // One argument: `refresh` stays unset, so the plugin's five-minute cache answers and no extra
    // `agy` process is spawned by a Paseo usage refresh.
    expect(readQuota).toHaveBeenCalledWith("work");
    expect(readQuota).toHaveBeenCalledTimes(1);
  });

  it("refuses an account that is no longer configured without spawning agy", async () => {
    const readQuota = vi.fn(async () => OK_QUOTA);
    const source = createUsageSource(options({ readQuota }));

    await expect(source.fetch({ accountId: "gone" })).resolves.toEqual({
      status: "error",
      error: 'Antigravity account "gone" is not configured',
    });
    expect(readQuota).not.toHaveBeenCalled();
  });

  it("accepts only the account locator it publishes", () => {
    expect(usageInputSchema.safeParse({ accountId: "work" }).success).toBe(true);
    expect(usageInputSchema.safeParse({ accountId: "work", extra: true }).success).toBe(false);
    expect(usageInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("registration", () => {
  it("registers a source the daemon can discover and fetch", async () => {
    const source: UsageSourceRegistration = createUsageSource(
      options({ readQuota: async () => OK_QUOTA }),
    );

    expect(source).toMatchObject({
      id: "antigravity-cli",
      label: "Antigravity",
      icon: "icon.svg",
    });
    expect(await source.discover({ kind: "global" })).toHaveLength(2);
    await expect(source.fetch({ accountId: "work" })).resolves.toMatchObject({ status: "available" });
  });
});
