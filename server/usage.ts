import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import {
  DEFAULT_ACCOUNT_ID,
  accountHome,
  listAccounts,
  readAccounts,
  type Account,
  type AccountsState,
} from "./accounts";
import { PROVIDER_ID } from "./provider";
import { readAccountQuota, type QuotaBucket, type QuotaGroup, type QuotaResult } from "./quota";

/**
 * Paseo's built-in usage summary reads accounts through this source. It is a second face for
 * `readAccountQuota`, not a second reader: every fetch goes through the existing five-minute
 * cache, so opening the usage screen never adds an `agy` process to the one the accounts screen
 * already causes.
 *
 * The plugin's own quota screen and RPCs stay as they are; this source only publishes the same
 * figures under the daemon's account identities.
 */

/** The SDK requires `^[A-Za-z0-9._-]{1,128}$`; plugin ids are slugs, but never trust that here. */
const ACCOUNT_KEY = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The account locator stored by the daemon. It is the plugin's own id, so a stale locator still
 * names the account the user chose rather than an opaque index.
 */
export const usageInputSchema = z.object({ accountId: z.string().min(1) }).strict();

/** Injected by the tests; the defaults are the plugin's real readers and paths. */
export interface UsageSourceOptions {
  listAccounts?: () => Account[];
  readAccounts?: () => AccountsState;
  accountHome?: (id: string) => string | null;
  homeDir?: () => string;
  readQuota?: (id: string, options?: { refresh?: boolean }) => Promise<QuotaResult>;
}

/**
 * Stable, legal account key. The plugin id already fits in practice; hashing a non-conforming one
 * keeps the daemon's schema satisfiable without leaking a name that could not be a key.
 */
export function usageAccountKey(id: string): string {
  return ACCOUNT_KEY.test(id) ? id : hashAccountKey(id);
}

/**
 * One `QuotaResult` as the daemon's usage report. `signed-out` is a rejected login rather than an
 * expired one: `agy` gives no expiry to show and the user's remedy is to sign in again.
 */
export function reportFromQuota(result: QuotaResult): UsageReport {
  switch (result.state) {
    case "ok":
      return { status: "available", windows: quotaWindows(result.groups) };
    case "signed-out":
      return unavailable({ kind: "rejected", status: 401 });
    case "unavailable":
      return unavailable({ kind: "no_quota", detail: result.message });
    case "error":
      return { status: "error", error: result.message };
  }
}

export function createUsageSource(options: UsageSourceOptions = {}): UsageSourceRegistration {
  const list = options.listAccounts ?? listAccounts;
  const read = options.readAccounts ?? readAccounts;
  const homeOf = options.accountHome ?? accountHome;
  const home = options.homeDir ?? homedir;
  const readQuota = options.readQuota ?? readAccountQuota;

  return {
    // The daemon's source registry is global across plugins and built-ins. The plugin's own id
    // keeps this source from colliding with a future built-in "antigravity" source.
    id: "antigravity-cli",
    label: "Antigravity",
    icon: "icon.svg",
    input: usageInputSchema,
    async discover(scope: UsageScope): Promise<UsageAccount[]> {
      const accounts = list();
      if (scope.kind === "global") return accounts.map(toUsageAccount);
      // Every source is asked about every agent session; only Antigravity sessions belong here.
      if (scope.provider !== PROVIDER_ID) return [];
      const id = sessionAccountId(scope.env, accounts, read, homeOf, home);
      const account = accounts.find((candidate) => candidate.id === id);
      return account ? [toUsageAccount(account)] : [];
    },
    async fetch(rawInput: unknown): Promise<UsageReport> {
      const { accountId } = usageInputSchema.parse(rawInput);
      // The account can be removed between discovery and this fetch. Refuse before the cache or a
      // spawn is asked about a shadow home that no longer exists.
      const account = list().find((candidate) => candidate.id === accountId);
      if (!account) {
        return { status: "error", error: `Antigravity account "${accountId}" is not configured` };
      }
      return reportFromQuota(await readQuota(account.id));
    },
  };
}

function toUsageAccount(account: Account): UsageAccount {
  return {
    key: usageAccountKey(account.id),
    label: account.name,
    harness: "Antigravity",
    input: { accountId: account.id },
  };
}

/**
 * Which account a session runs under. The provider launches a non-Default account with
 * `HOME=<shadow home>`, so that is the only identity a session exposes; the real home is Default.
 * Without either, the host-wide active account is what a fresh session would take.
 */
function sessionAccountId(
  env: Record<string, string>,
  accounts: readonly Account[],
  read: () => AccountsState,
  homeOf: (id: string) => string | null,
  home: () => string,
): string {
  const sessionHome = env.HOME;
  if (typeof sessionHome === "string" && sessionHome.length > 0) {
    const target = resolve(sessionHome);
    for (const account of accounts) {
      const path = homeOf(account.id);
      if (path !== null && resolve(path) === target) return account.id;
    }
    if (resolve(home()) === target) return DEFAULT_ACCOUNT_ID;
  }
  return read().active;
}

/**
 * One window per bucket. The first group that reported anything is Antigravity's own model family
 * and carries the limits a user is most likely to hit; marking only that group keeps third-party
 * model limits out of the summary until the user pins them.
 */
function quotaWindows(groups: readonly QuotaGroup[]): UsageWindow[] {
  const summaryGroup = groups.findIndex((group) => group.buckets.length > 0);
  return groups.flatMap((group, groupIndex) =>
    group.buckets.map((bucket) => {
      const name = windowName(bucket);
      const usedPct = usedPercent(bucket.remainingFraction);
      return windowFromUsedPct({
        id: group.name.length > 0 ? `${group.name}/${bucket.id}` : bucket.id,
        label: group.name.length > 0 ? `${group.name} · ${name.label}` : name.label,
        shortLabel: name.shortLabel,
        summary: groupIndex === summaryGroup,
        utilizationPct: usedPct,
        // `""` is agy's "no reset time"; the SDK wants null there.
        resetsAt: bucket.resetTime === "" ? null : bucket.resetTime,
        tone: toneFromUsedPct(usedPct),
      });
    }),
  );
}

/** The window names `agy` reports today, with a compact form for the summary. */
const WINDOW_NAMES: Readonly<Record<string, { label: string; shortLabel: string }>> = {
  "5h": { label: "5-hour", shortLabel: "5h" },
  weekly: { label: "Weekly", shortLabel: "wk" },
};

function windowName(bucket: QuotaBucket): { label: string; shortLabel?: string } {
  const known = WINDOW_NAMES[bucket.window.trim().toLowerCase()];
  if (known) return known;
  // A newer `agy` may report a window this plugin has never seen; show it as given rather than
  // inventing a duration, and fall back to the bucket name when it reports none.
  if (bucket.window.length > 0) return { label: bucket.window, shortLabel: bucket.window };
  return { label: bucket.name };
}

/**
 * 0..100 in whole percents, like the plugin's own quota screen: `agy` reports a share with float
 * noise (0.7616450190544128), which Paseo would otherwise print digit for digit.
 */
function usedPercent(remainingFraction: number): number {
  const used = Math.round(100 - remainingFraction * 100);
  return Math.min(100, Math.max(0, used));
}
