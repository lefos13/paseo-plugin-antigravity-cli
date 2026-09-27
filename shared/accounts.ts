import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The RPC contracts behind the "Antigravity accounts" sidebar screen. Shared code only: Zod
 * schemas and plain values, no Node and no React Native. The daemon registers one handler per
 * contract in `index.server.ts`; the surface calls them through `useRpc`.
 *
 * RPC names are lowercase by SDK rule (`/^[a-z][a-z0-9._-]*$/` in `defineRpc`), so the plan's
 * `accounts.setActive`/`accounts.signIn` are spelled `accounts.set-active`/`accounts.sign-in`.
 */

/** One account as the screen lists it. Default is the real home and is always present. */
export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * The whole store: the active account's id and every account, Default first. Read-only on the
 * client; there is no "write the store" RPC because every mutation below rewrites it.
 */
export const accountsList = defineRpc({
  name: "accounts.list",
  input: z.object({}),
  output: z.object({
    active: z.string(),
    accounts: z.array(accountSchema),
  }),
});

/** Switching the host-wide active account: every *new* agent spawns under it. */
export const accountsSetActive = defineRpc({
  name: "accounts.set-active",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ active: z.string() }),
});

/** Creates the shadow home and records the account. Signing in is a separate step. */
export const accountsAdd = defineRpc({
  name: "accounts.add",
  input: z.object({ name: z.string().min(1) }),
  output: accountSchema,
});

/** Deletes the account's own directory and its history. The real home is never touched. */
export const accountsRemove = defineRpc({
  name: "accounts.remove",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ removed: z.string(), active: z.string() }),
});

/**
 * Opens a native terminal window on the daemon machine that runs `agy` with this account's
 * `HOME`. `launched` is false off macOS or when the opener fails; `command` is always the exact
 * line to paste into a terminal there. `host` names the machine the window would open on.
 */
export const accountsSignIn = defineRpc({
  name: "accounts.sign-in",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({
    launched: z.boolean(),
    host: z.string(),
    command: z.string(),
  }),
});

/** The two settings this plugin owns. `editable` is false for Default, which `agy` manages. */
const accountSettingsSchema = z.object({
  toolPermission: z.string().nullable(),
  trustedWorkspaces: z.array(z.string()),
  editable: z.boolean(),
});

export const accountsSettingsGet = defineRpc({
  name: "accounts.settings.get",
  input: z.object({ id: z.string().min(1) }),
  output: accountSettingsSchema,
});

export const accountsSettingsUpdate = defineRpc({
  name: "accounts.settings.update",
  input: z.object({
    id: z.string().min(1),
    toolPermission: z.string().optional(),
    trustedWorkspaces: z.array(z.string()).optional(),
  }),
  output: accountSettingsSchema,
});

/**
 * `toolPermission` values `agy` documents (1.2.9). The screen shows these plus the account's
 * current value when it is something else, so an unknown value is never silently replaced.
 */
export const TOOL_PERMISSIONS: readonly string[] = [
  "always-proceed",
  "request-review",
  "agent-decides",
  "turbo",
];

/** One quota bucket: a pool `agy` reports a remaining share and a reset time for. */
const quotaBucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `agy`'s own window name (`5h`, `weekly`, …), shown as the row's window label. */
  window: z.string(),
  /** 0..1, as `agy` reported it. */
  remainingFraction: z.number(),
  /** RFC3339 UTC, or `""` when `agy` reported no reset time for this bucket. */
  resetTime: z.string(),
});

const quotaGroupSchema = z.object({
  name: z.string(),
  buckets: z.array(quotaBucketSchema),
});

/**
 * What one account's quota read produced. `ok` is the only state that is cached; `signed-out` is an
 * account the CLI will not answer for, `unavailable` is `agy` itself reporting an error (its own
 * message is passed through), and `error` is a read the plugin could not turn into an answer —
 * a failed or timed-out process, or output in a shape it does not know.
 */
export const quotaResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    /** Epoch milliseconds, when `agy` answered. */
    fetchedAt: z.number(),
    groups: z.array(quotaGroupSchema),
  }),
  z.object({ state: z.literal("signed-out") }),
  z.object({ state: z.literal("unavailable"), message: z.string() }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);

/**
 * One account's usage quota, read through the account's own `agy -p /usage --output-format json`
 * (see `server/quota.ts`). `refresh` bypasses the 5-minute cache but still joins a running read.
 */
export const accountsQuota = defineRpc({
  name: "accounts.quota",
  input: z.object({ id: z.string().min(1), refresh: z.boolean().optional() }),
  output: quotaResultSchema,
});
