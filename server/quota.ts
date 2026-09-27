import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { DEFAULT_ACCOUNT_ID, accountHome, syncShadowHome } from "./accounts";
import { resolveAgyBinary } from "./agy";

const execFileAsync = promisify(execFile);

/**
 * An account's remaining quota, read through the official binary's own print-mode answer:
 *
 *   HOME=<account home> agy -p /usage --output-format json
 *
 * `agy` 1.1.11+ answers the read-only slash commands in print mode "without starting an agent turn,
 * spending quota, or leaving a conversation behind" (its own changelog), so this is the same kind of
 * call as launching a session: the plugin passes no token, contacts no Google endpoint and reads no
 * file `agy` owns — it parses the stdout of the documented command. See
 * `tasks/quota-research/agy-local.md`.
 *
 * The argv is exactly `["-p", "/usage", "--output-format", "json"]` and nothing else:
 *  - `--disable-slash-commands`, which every *session* launch carries, would stop `/usage` from
 *    expanding and turn it into a real agent turn that spends quota, which is why this is its own
 *    short-lived process rather than the session the plugin already runs;
 *  - `--input-format stream-json` is refused outright by the binary for `/usage`;
 *  - a model, `--add-dir` or a conversation id would only make the turn depend on state it does not
 *    need, so it runs from the temp directory with none of them.
 *
 * Only a successful answer is cached (5 minutes per account), because a signed-out or failed read is
 * worth retrying as soon as the user does something about it. Concurrent calls share one process.
 */
export interface QuotaBucket {
  id: string;
  name: string;
  /** `agy`'s own window name: `5h`, `weekly`, or whatever it reports next. */
  window: string;
  /** 0..1, exactly as `agy` reports it. */
  remainingFraction: number;
  /** RFC3339 UTC; `""` when `agy` reported no reset time for this bucket. */
  resetTime: string;
}

export interface QuotaGroup {
  name: string;
  buckets: QuotaBucket[];
}

/**
 * `ok` carries the buckets `agy` reported. `signed-out` is an account the CLI will not read quota
 * for; `unavailable` is `agy` itself reporting an error (an account with no quota summary, an
 * enterprise workspace without per-model quotas); `error` is everything the plugin could not turn
 * into a quota answer — a spawn failure, a timeout, or output in a shape this parser does not know.
 */
export type QuotaResult =
  | { state: "ok"; fetchedAt: number; groups: QuotaGroup[] }
  | { state: "signed-out" }
  | { state: "unavailable"; message: string }
  | { state: "error"; message: string };

const CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTA_TIMEOUT_MS = 60_000;

/**
 * One entry per account. Every value here belongs to the account whose `HOME` the CLI ran with, so
 * there is nothing to share between accounts and an account that is removed takes its entry with it.
 */
const cache = new Map<string, { at: number; result: QuotaResult }>();

/**
 * The read under way per account, if any. A second request joins it instead of starting a second
 * `agy` process — the CLI answers one quota question with one network round trip and takes tens of
 * seconds, and the accounts screen asks for every account at once.
 */
const inFlight = new Map<string, Promise<QuotaResult>>();

/**
 * Reads one account's quota. `refresh` answers from `agy` again even when a cached answer is still
 * fresh; it still joins a read that is already running. A non-Default account is synced first, as a
 * spawn is: the sync unlocks the account's Keychain, so a reboot-locked one cannot raise a password
 * dialog behind a screen that is only reading figures.
 */
export async function readAccountQuota(
  id: string,
  options: { refresh?: boolean } = {},
): Promise<QuotaResult> {
  // Also the account check: an id that is not in the store fails here, before the cache can answer
  // for it, exactly as the settings RPCs do.
  if (id !== DEFAULT_ACCOUNT_ID) syncShadowHome(id);

  const cached = cache.get(id);
  if (options.refresh !== true && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const running = inFlight.get(id);
  if (running) return running;

  const read = fetchQuota(id)
    .then((result) => {
      // `forgetAccountQuota` drops the in-flight entry too, so a read that was started for an
      // account that has since been removed cannot write its answer back into the cache.
      if (result.state === "ok" && inFlight.get(id) === read) {
        cache.set(id, { at: Date.now(), result });
      }
      return result;
    })
    .finally(() => {
      if (inFlight.get(id) === read) inFlight.delete(id);
    });
  inFlight.set(id, read);
  return read;
}

/**
 * Forgets an account's cached answer, for the removal path: the id can be added again, and the new
 * account must not be served the old one's figures. A read already running for it is dropped too.
 */
export function forgetAccountQuota(id: string): void {
  cache.delete(id);
  inFlight.delete(id);
}

/** Drops every cached answer; the tests use it between cases the way `vi.resetModules()` would. */
export function clearQuotaCache(): void {
  cache.clear();
  inFlight.clear();
}

async function fetchQuota(id: string): Promise<QuotaResult> {
  const home = accountHome(id);
  const binary = resolveAgyBinary();
  try {
    const { stdout, stderr } = await execFileAsync(binary, QUOTA_ARGS, {
      cwd: tmpdir(),
      timeout: QUOTA_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      // Default is the real home and gets today's env: no HOME is invented for it.
      ...(home === null ? {} : { env: { ...process.env, HOME: home } }),
    });
    return parseQuotaOutput(stdout, stderr, binary);
  } catch (error) {
    // A failed process still carries what it printed, and a signed-out `agy` may report the reason
    // on the way out. Only after that is the failure itself the answer.
    const failed = asRecord(error);
    const printed = [failed?.stdout, failed?.stderr]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (SIGNED_OUT.test(printed)) return { state: "signed-out" };
    return {
      state: "error",
      message:
        failed?.killed === true
          ? `agy (${binary}) did not answer /usage within ${QUOTA_TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

const QUOTA_ARGS = ["-p", "/usage", "--output-format", "json"] as const;

/**
 * `agy`'s answer to a read-only command, as far as this parser trusts it. Every leaf is optional and
 * unknown keys are kept: `agy` updates often and the shape is undocumented, so a missing field has to
 * read as "not what we expect" (an error state) rather than crash the daemon.
 */
const commandResultSchema = z.looseObject({
  status: z.string().optional(),
  error: z.unknown().optional(),
  response: z.unknown().optional(),
  num_turns: z.unknown().optional(),
  command: z.unknown().optional(),
});

/** `Please sign in` is what a logged-out CLI says, on whichever channel it chooses. */
const SIGNED_OUT = /please sign in|not logged into/i;

/**
 * Turns one `/usage` answer into a quota result. Exported because it is the whole contract with the
 * binary: the fixtures are real captured output, and reading them through this function is what
 * makes the parse testable without spawning anything.
 */
export function parseQuotaOutput(stdout: string, stderr: string, binary = "agy"): QuotaResult {
  // Before any shape check: a signed-out CLI may answer with a JSON result whose `response` is the
  // sign-in line, a plain-text line, or a non-zero exit with the reason on stderr.
  if (SIGNED_OUT.test(`${stdout}\n${stderr}`)) return { state: "signed-out" };

  const json = parseJsonObject(stdout);
  if (json === null) {
    return { state: "error", message: `agy (${binary}) did not answer /usage with JSON` };
  }
  const parsed = commandResultSchema.safeParse(json);
  if (!parsed.success) {
    return { state: "error", message: `agy (${binary}) answered /usage with an unexpected payload` };
  }
  const { status, error, response, num_turns, command } = parsed.data;

  if (status === "ERROR") {
    // `agy`'s own message, which is the useful thing to show: "no quota summary is available for
    // this account", or an enterprise account's "do not have per-model quotas".
    const message = asText(error) ?? asText(response);
    return { state: "unavailable", message: message ?? "agy reported an error reading quota" };
  }
  if (status !== "SUCCESS") {
    return {
      state: "error",
      message: `agy (${binary}) answered /usage with status ${JSON.stringify(status)}`,
    };
  }
  // The guard against a `/usage` that became a real agent turn (which spends quota): a command
  // answer is not a turn.
  if (num_turns !== 0) {
    return {
      state: "error",
      message: `agy (${binary}) ran ${JSON.stringify(num_turns)} turns for /usage`,
    };
  }
  const commandName = asRecord(command)?.name;
  if (typeof commandName !== "string" || !["usage", "quota"].includes(commandName.toLowerCase())) {
    return {
      state: "error",
      message: `agy (${binary}) answered with the command ${JSON.stringify(commandName)}, not /usage`,
    };
  }

  const groups = readGroups(command);
  if (groups === null) {
    return { state: "error", message: `agy (${binary}) answered /usage without any groups` };
  }
  return { state: "ok", fetchedAt: Date.now(), groups };
}

/**
 * The groups of `command.data`, each carrying the buckets that reported a finite remaining share. A
 * bucket without one is dropped rather than shown as 0 %: the UI can only be right about what the
 * CLI actually said.
 */
function readGroups(command: unknown): QuotaGroup[] | null {
  const data = asRecord(asRecord(command)?.data);
  const raw = data?.groups;
  if (!Array.isArray(raw)) return null;

  const groups: QuotaGroup[] = [];
  for (const value of raw) {
    const record = asRecord(value);
    if (record === null) continue;
    const rawBuckets = Array.isArray(record.buckets) ? record.buckets : [];
    const buckets: QuotaBucket[] = [];
    for (const bucket of rawBuckets) {
      const parsed = readBucket(bucket);
      if (parsed !== null) buckets.push(parsed);
    }
    groups.push({ name: asText(record.name) ?? "", buckets });
  }
  return groups;
}

function readBucket(value: unknown): QuotaBucket | null {
  const record = asRecord(value);
  if (record === null) return null;
  const fraction = record.remaining_fraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  const name = asText(record.name);
  const id = asText(record.id) ?? name;
  // Nothing to identify the bucket by: its id is the idempotent key the screen renders with.
  if (id === null) return null;
  return {
    id,
    name: name ?? id,
    window: asText(record.window) ?? "",
    remainingFraction: fraction,
    resetTime: asText(record.reset_time) ?? "",
  };
}

/** The first line of `stdout` that is a JSON object, so a banner line cannot hide the answer. */
function parseJsonObject(stdout: string): unknown {
  const text = stdout.trim();
  if (text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      // Not one object: it may be preceded by a banner, so try the lines.
    }
  }
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, which is what every field this parser keeps has to be. */
function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
