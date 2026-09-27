import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "./accounts";
import { clearQuotaCache, forgetAccountQuota, parseQuotaOutput, readAccountQuota } from "./quota";
import { installFakeSecurity, type FakeSecurity } from "./testing/fake-security";

/**
 * Reading an account's quota through `agy -p /usage --output-format json`. Every case runs the real
 * `server/quota.ts` against the fake CLI: what is asserted is the argv and `HOME` the process got,
 * the shape the parser publishes, and what the cache does — never a source-text echo.
 */

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));

const originalHome = process.env.HOME;
const originalPaseoHome = process.env.PASEO_HOME;
const originalBinary = process.env.PASEO_ANTIGRAVITY_BIN;

/** The same window `server/quota.ts` caches a successful answer for. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let root: string;
let home: string;
let paseoHome: string;
let logPath: string;
/** Syncing an account unlocks its Keychain: the real `/usr/bin/security` must never be reached. */
let security: FakeSecurity;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-quota-"));
  home = join(root, "home");
  paseoHome = join(root, "paseo-home");
  logPath = join(root, "quota.log");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.PASEO_HOME = paseoHome;
  chmodSync(fakeAgy, 0o755);
  process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
  delete process.env.FAKE_QUOTA;
  process.env.FAKE_QUOTA_LOG = logPath;
  security = installFakeSecurity("darwin");
  clearQuotaCache();
});

afterEach(() => {
  security.restore();
  vi.useRealTimers();
  clearQuotaCache();
  delete process.env.FAKE_QUOTA;
  delete process.env.FAKE_QUOTA_LOG;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  if (originalBinary === undefined) delete process.env.PASEO_ANTIGRAVITY_BIN;
  else process.env.PASEO_ANTIGRAVITY_BIN = originalBinary;
  rmSync(root, { recursive: true, force: true });
});

/** The shadow home of an account created by these tests, as `server/accounts.ts` lays it out. */
function shadowHome(id: string): string {
  return join(paseoHome, "plugin-data", "antigravity-cli", "accounts", id, "home");
}

interface QuotaLaunch {
  argv: string[];
  HOME: string | null;
  cwd: string;
}

/** Every `/usage` launch the fake CLI saw, in order. */
function launches(): QuotaLaunch[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as QuotaLaunch);
}

describe("readAccountQuota spawn", () => {
  it("runs the print-mode command under the account's HOME, from the temp directory", async () => {
    addAccount("Work");
    const before = security.calls.length;

    const result = await readAccountQuota("work");

    expect(result.state).toBe("ok");
    expect(launches()).toEqual([
      {
        argv: ["-p", "/usage", "--output-format", "json"],
        HOME: shadowHome("work"),
        cwd: expect.any(String),
      },
    ]);
    // A quota read is a plain command answer, never a session: no --disable-slash-commands, no
    // --input-format, no --add-dir and no model, whichever flags a session would carry.
    const [launch] = launches();
    expect(launch.argv).toHaveLength(4);
    // The CLI runs from the temp directory, so no project directory is involved.
    expect(realpathSync(launch.cwd)).toBe(realpathSync(tmpdir()));
    expect(launch.HOME).not.toBe(home);

    // The account was synced first, which is what unlocks its Keychain before a spawn.
    const during = security.calls.slice(before);
    expect(
      during.some((call) => call.args[0] === "unlock-keychain" && call.home === shadowHome("work")),
    ).toBe(true);
  });

  it("adds no HOME override for Default", async () => {
    // Without a HOME in the daemon's env, an inherited HOME would still be set; a read that invents
    // one shows up here as a value where the CLI should have seen none at all.
    const saved = process.env.HOME;
    delete process.env.HOME;
    try {
      await readAccountQuota("default");
    } finally {
      process.env.HOME = saved;
    }

    expect(launches()).toHaveLength(1);
    expect(launches()[0].HOME).toBeNull();
  });
});

describe("readAccountQuota parse", () => {
  it("reports the groups and buckets of a successful answer", async () => {
    addAccount("Work");

    const result = await readAccountQuota("work");

    expect(result).toEqual({
      state: "ok",
      fetchedAt: expect.any(Number),
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
              resetTime: "2026-09-27T16:10:09Z",
            },
          ],
        },
        {
          // `3p-5h` reported no remaining_fraction and is dropped rather than shown as 0 %.
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
    });
  });

  it("reports each way `agy` fails to answer with quota", async () => {
    addAccount("Work");

    process.env.FAKE_QUOTA = "signed-out";
    expect(await readAccountQuota("work")).toEqual({ state: "signed-out" });

    process.env.FAKE_QUOTA = "error";
    expect(await readAccountQuota("work")).toEqual({
      state: "unavailable",
      // `agy`'s own message, which is what the screen has to show.
      message: "no quota summary is available for this account",
    });

    process.env.FAKE_QUOTA = "agent-turn";
    // A `/usage` that became a real turn spends quota, so its answer must never read as quota.
    expect(await readAccountQuota("work")).toEqual({
      state: "error",
      message: expect.stringMatching(/turns/),
    });

    process.env.FAKE_QUOTA = "garbage";
    expect(await readAccountQuota("work")).toEqual({
      state: "error",
      message: expect.stringMatching(/JSON/),
    });
  });

  it("reads the sign-in line out of a result body as well as a failed process", () => {
    // A logged-out CLI may answer with a normal result whose response is the sign-in line.
    expect(
      parseQuotaOutput(
        `${JSON.stringify({
          status: "SUCCESS",
          response: "You are not logged into Antigravity. Please sign in to continue.",
          num_turns: 0,
        })}\n`,
        "",
      ),
    ).toEqual({ state: "signed-out" });
    expect(parseQuotaOutput("", "Please sign in to Antigravity.\n")).toEqual({ state: "signed-out" });
    // Any other JSON object is not a quota answer: the command name has to be the one asked for.
    expect(parseQuotaOutput('{"status":"SUCCESS","num_turns":0,"command":{"name":"credits"}}', "")).toMatchObject(
      { state: "error" },
    );
    // `/quota` is the same command under its alias.
    expect(
      parseQuotaOutput(
        JSON.stringify({
          status: "SUCCESS",
          num_turns: 0,
          command: { name: "quota", data: { groups: [{ name: "Gemini Models", buckets: [] }] } },
        }),
        "",
      ),
    ).toMatchObject({ state: "ok", groups: [{ name: "Gemini Models", buckets: [] }] });
  });

  it("keeps an exhausted bucket and drops only the ones without a finite share", () => {
    const buckets = [
      { id: "exhausted", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0 },
      { id: "absent", name: "Five Hour Limit Remaining", window: "5h" },
      { id: "null", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: null },
      { id: "string", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: "0.5" },
      // No id and no name: nothing the screen could key or label the row by.
      { window: "weekly", remaining_fraction: 0.5 },
    ];

    expect(
      parseQuotaOutput(
        JSON.stringify({
          status: "SUCCESS",
          num_turns: 0,
          command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets }] } },
        }),
        "",
      ),
    ).toEqual({
      state: "ok",
      fetchedAt: expect.any(Number),
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "exhausted",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remainingFraction: 0,
              resetTime: "",
            },
          ],
        },
      ],
    });
  });
});

describe("readAccountQuota cache", () => {
  it("answers a second read from the cache and reads again on refresh", async () => {
    addAccount("Work");

    expect((await readAccountQuota("work")).state).toBe("ok");
    expect((await readAccountQuota("work")).state).toBe("ok");
    expect(launches()).toHaveLength(1);

    // `refresh` bypasses the cache even while it is fresh.
    expect((await readAccountQuota("work", { refresh: true })).state).toBe("ok");
    expect(launches()).toHaveLength(2);
  });

  it("reads again once the cached answer is older than five minutes", async () => {
    addAccount("Work");
    await readAccountQuota("work");
    expect(launches()).toHaveLength(1);

    // Only `Date` is faked: the child process and its I/O stay on real time.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1);
    expect((await readAccountQuota("work")).state).toBe("ok");
    vi.useRealTimers();

    expect(launches()).toHaveLength(2);
  });

  it("merges concurrent reads into one process, refresh included", async () => {
    addAccount("Work");

    const [first, second, refreshed] = await Promise.all([
      readAccountQuota("work"),
      readAccountQuota("work"),
      // A refresh does not start a second process while one is already reading.
      readAccountQuota("work", { refresh: true }),
    ]);

    expect(first).toEqual(second);
    expect(refreshed).toEqual(first);
    expect(first.state).toBe("ok");
    expect(launches()).toHaveLength(1);
  });

  it("does not cache a failed read", async () => {
    addAccount("Work");
    process.env.FAKE_QUOTA = "error";

    expect((await readAccountQuota("work")).state).toBe("unavailable");
    expect((await readAccountQuota("work")).state).toBe("unavailable");
    expect(launches()).toHaveLength(2);

    process.env.FAKE_QUOTA = "garbage";
    expect((await readAccountQuota("work")).state).toBe("error");
    process.env.FAKE_QUOTA = "error";
    expect((await readAccountQuota("work")).state).toBe("unavailable");
    expect(launches()).toHaveLength(4);
  });

  it("forgets an account's cached answer when asked to", async () => {
    addAccount("Work");
    await readAccountQuota("work");
    await readAccountQuota("work");
    expect(launches()).toHaveLength(1);

    forgetAccountQuota("work");

    expect((await readAccountQuota("work")).state).toBe("ok");
    expect(launches()).toHaveLength(2);
  });

  it("refuses an account that is not in the store, without spawning anything", async () => {
    await expect(readAccountQuota("nope")).rejects.toThrow(/Unknown account: nope/);
    expect(launches()).toHaveLength(0);
  });
});
