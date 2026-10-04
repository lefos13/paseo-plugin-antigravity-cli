import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountsAdd,
  accountsList,
  accountsQuota,
  accountsRemove,
  accountsSetActive,
  accountsSettingsGet,
  accountsSettingsUpdate,
  accountsSignIn,
} from "../shared/accounts";
import contribute from "../index.server";
import { accountHome, readAccountSettings } from "./accounts";
import { FALLBACK_MODELS, buildCatalog, currentModels } from "./catalog";
import { clearQuotaCache } from "./quota";
import { installFakeSecurity, type FakeSecurity } from "./testing/fake-security";

/**
 * The RPCs the "Antigravity accounts" screen calls. These tests drive the *real* handlers
 * registered by `index.server.ts` through a fake server context, so what is asserted is what the
 * daemon publishes: contract name, input schema, handler, output schema.
 */

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));

const originalHome = process.env.HOME;
const originalPaseoHome = process.env.PASEO_HOME;
const originalBinary = process.env.PASEO_ANTIGRAVITY_BIN;

const contracts = [
  accountsList,
  accountsSetActive,
  accountsAdd,
  accountsRemove,
  accountsSignIn,
  accountsSettingsGet,
  accountsSettingsUpdate,
  accountsQuota,
];

/** Handlers keyed by RPC name; names are the only stable handle across module instances. */
let handlers: Record<string, (input: never) => unknown> = {};

let root: string;
let paseoHome: string;
/** The RPCs create accounts, which sync shadow homes: `/usr/bin/security` must never be the real one. */
let security: FakeSecurity;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-rpc-"));
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  paseoHome = join(root, "paseo-home");
  process.env.PASEO_HOME = paseoHome;
  chmodSync(fakeAgy, 0o755);
  process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
  security = installFakeSecurity("linux");
  clearQuotaCache();

  handlers = {};
  const register = (contract: { name: string }, handler: (input: never) => unknown) => {
    handlers[contract.name] = handler;
  };
  contribute({
    registerProvider: () => {},
    handle: register,
  } as unknown as PluginServerContext);
});

afterEach(() => {
  security.restore();
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  if (originalBinary === undefined) delete process.env.PASEO_ANTIGRAVITY_BIN;
  else process.env.PASEO_ANTIGRAVITY_BIN = originalBinary;
  delete process.env.FAKE_MODELS_OK;
  delete process.env.FAKE_QUOTA;
  delete process.env.FAKE_QUOTA_LOG;
  rmSync(root, { recursive: true, force: true });
});

async function invoke(name: string, input: unknown = {}): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) throw new Error(`No handler is registered for ${name}`);
  return await handler(input as never);
}

/** The RPC's own output schema is the contract the client validates against; every reply must pass. */
function validated<Contract extends { output: { parse(value: unknown): unknown } }>(
  contract: Contract,
  reply: unknown,
): unknown {
  return contract.output.parse(reply);
}

/** How many `/usage` processes the fake CLI ran, which is how a test sees the cache. */
function quotaRuns(logPath: string): number {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

describe("account RPC contracts", () => {
  it("registers every contract under an SDK-legal name", () => {
    for (const contract of contracts) {
      expect(contract.name).toMatch(/^[a-z][a-z0-9._-]*$/);
      expect(handlers[contract.name]).toBeTypeOf("function");
    }
  });

  it("accepts only well-formed input and output", () => {
    expect(accountsList.input.safeParse({}).success).toBe(true);
    expect(accountsList.input.safeParse(null).success).toBe(false);
    expect(accountsAdd.input.safeParse({ name: "" }).success).toBe(false);
    expect(accountsAdd.input.safeParse({ name: 7 }).success).toBe(false);
    expect(accountsSetActive.input.safeParse({ id: "" }).success).toBe(false);
    expect(accountsSettingsUpdate.input.safeParse({ id: "work", toolPermission: 2 }).success).toBe(
      false,
    );
    expect(accountsSettingsUpdate.input.safeParse({ id: "work" }).success).toBe(true);
    expect(
      accountsSettingsGet.output.safeParse({ toolPermission: null, trustedWorkspaces: [], editable: true })
        .success,
    ).toBe(true);
    expect(accountsSignIn.output.safeParse({ launched: "yes", host: "h", command: "c" }).success).toBe(
      false,
    );
    expect(accountsQuota.input.safeParse({ id: "work" }).success).toBe(true);
    expect(accountsQuota.input.safeParse({ id: "work", refresh: true }).success).toBe(true);
    expect(accountsQuota.input.safeParse({ id: "work", refresh: "yes" }).success).toBe(false);
    expect(accountsQuota.input.safeParse({}).success).toBe(false);
    expect(accountsQuota.output.safeParse({ state: "signed-out" }).success).toBe(true);
    expect(accountsQuota.output.safeParse({ state: "unavailable", message: "m" }).success).toBe(true);
    expect(accountsQuota.output.safeParse({ state: "ok", fetchedAt: 1, groups: [] }).success).toBe(true);
    // `ok` without when it was fetched is not an answer the screen could date.
    expect(accountsQuota.output.safeParse({ state: "ok", groups: [] }).success).toBe(false);
  });
});

describe("accounts.list", () => {
  it("lists Default first and reports it active until something else is chosen", async () => {
    expect(validated(accountsList, await invoke("accounts.list"))).toEqual({
      active: "default",
      multiAccount: true,
      accounts: [{ id: "default", name: "Default" }],
    });

    await invoke("accounts.add", { name: "Work" });

    expect(validated(accountsList, await invoke("accounts.list"))).toEqual({
      active: "default",
      multiAccount: true,
      accounts: [
        { id: "default", name: "Default" },
        { id: "work", name: "Work" },
      ],
    });
  });
});

describe("accounts.add", () => {
  it("returns the created account and rejects a name that is already taken", async () => {
    expect(validated(accountsAdd, await invoke("accounts.add", { name: " Work " }))).toEqual({
      id: "work",
      name: "Work",
    });
    await expect(invoke("accounts.add", { name: "work" })).rejects.toThrow(/already exists/);
    await expect(invoke("accounts.add", { name: "Default" })).rejects.toThrow(/reserved/);
  });
});

describe("accounts.set-active", () => {
  it("switches the store, refuses an unknown id, and drops the cached model lists", async () => {
    await invoke("accounts.add", { name: "Work" });
    process.env.FAKE_MODELS_OK = "1";
    await buildCatalog("work");
    expect(currentModels("work").some((model) => model.id === "fake-model-x")).toBe(true);

    expect(validated(accountsSetActive, await invoke("accounts.set-active", { id: "work" }))).toEqual({
      active: "work",
    });
    expect(validated(accountsList, await invoke("accounts.list"))).toMatchObject({ active: "work" });
    // The discovered list is gone, so the next catalog request runs `agy models` under the new
    // account instead of answering from the previous account's cache.
    expect(currentModels("work")).toEqual(FALLBACK_MODELS);

    await expect(invoke("accounts.set-active", { id: "nope" })).rejects.toThrow(/Unknown account: nope/);
  });
});

describe("accounts.remove", () => {
  it("refuses Default and unknown ids, and falls back to Default for the active one", async () => {
    await expect(invoke("accounts.remove", { id: "default" })).rejects.toThrow(/cannot be removed/);
    await expect(invoke("accounts.remove", { id: "nope" })).rejects.toThrow(/Unknown account: nope/);

    await invoke("accounts.add", { name: "Work" });
    await invoke("accounts.set-active", { id: "work" });

    expect(validated(accountsRemove, await invoke("accounts.remove", { id: "work" }))).toEqual({
      removed: "work",
      active: "default",
    });
    expect(validated(accountsList, await invoke("accounts.list"))).toEqual({
      active: "default",
      multiAccount: true,
      accounts: [{ id: "default", name: "Default" }],
    });
  });
});

describe("accounts.sign-in", () => {
  it("refuses Default", async () => {
    await expect(invoke("accounts.sign-in", { id: "default" })).rejects.toThrow(/Default account/);
  });

  it("hands the account's command to the launcher and reports where it would open", async () => {
    await invoke("accounts.add", { name: "Work" });
    // Off macOS the launcher never runs `open`, so no terminal window can appear during a test.
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const reply = validated(accountsSignIn, await invoke("accounts.sign-in", { id: "work" }));

    expect(reply).toMatchObject({ launched: false });
    expect((reply as { command: string }).command).toContain(accountHome("work")!);
    expect((reply as { command: string }).command).toContain(fakeAgy);
    expect((reply as { host: string }).host.length).toBeGreaterThan(0);
  });
});

describe("account settings", () => {
  it("shows Default read-only and an account editable", async () => {
    expect(validated(accountsSettingsGet, await invoke("accounts.settings.get", { id: "default" }))).toEqual({
      toolPermission: null,
      trustedWorkspaces: [],
      editable: false,
    });

    await invoke("accounts.add", { name: "Work" });
    expect(validated(accountsSettingsGet, await invoke("accounts.settings.get", { id: "work" }))).toEqual({
      toolPermission: null,
      trustedWorkspaces: [],
      editable: true,
    });
  });

  it("persists a patch for an account and refuses Default", async () => {
    await invoke("accounts.add", { name: "Work" });
    const reply = validated(
      accountsSettingsUpdate,
      await invoke("accounts.settings.update", {
        id: "work",
        toolPermission: "turbo",
        trustedWorkspaces: ["/src/app"],
      }),
    );
    expect(reply).toEqual({
      toolPermission: "turbo",
      trustedWorkspaces: ["/src/app"],
      editable: true,
    });
    expect(readAccountSettings("work")).toEqual({
      toolPermission: "turbo",
      trustedWorkspaces: ["/src/app"],
    });
    // A patch without trustedWorkspaces leaves the stored list alone.
    expect(
      validated(
        accountsSettingsUpdate,
        await invoke("accounts.settings.update", { id: "work", toolPermission: "agent-decides" }),
      ),
    ).toEqual({ toolPermission: "agent-decides", trustedWorkspaces: ["/src/app"], editable: true });

    await expect(
      invoke("accounts.settings.update", { id: "default", toolPermission: "turbo" }),
    ).rejects.toThrow(/Default account/);
  });
});

describe("accounts.quota", () => {
  it("answers with the account's own quota and keeps it until the account is removed", async () => {
    const logPath = join(root, "quota.log");
    process.env.FAKE_QUOTA_LOG = logPath;
    await invoke("accounts.add", { name: "Work" });

    const reply = validated(accountsQuota, await invoke("accounts.quota", { id: "work" }));
    expect(reply).toEqual({
      state: "ok",
      fetchedAt: expect.any(Number),
      groups: [
        expect.objectContaining({ name: "Gemini Models" }),
        expect.objectContaining({ name: "Claude and GPT models" }),
      ],
    });
    expect(quotaRuns(logPath)).toBe(1);

    // The screen asks again the next time it opens: the five-minute cache answers, so nothing runs.
    await invoke("accounts.quota", { id: "work" });
    expect(quotaRuns(logPath)).toBe(1);

    // Removing the account drops its cached answer: the id can be added again, and the new account
    // has to be read afresh rather than served the removed one's figures.
    await invoke("accounts.remove", { id: "work" });
    await invoke("accounts.add", { name: "Work" });
    expect(validated(accountsQuota, await invoke("accounts.quota", { id: "work" }))).toMatchObject({
      state: "ok",
    });
    expect(quotaRuns(logPath)).toBe(2);
  });

  it("refuses an unknown account", async () => {
    await expect(invoke("accounts.quota", { id: "nope" })).rejects.toThrow(/Unknown account: nope/);
  });
});
