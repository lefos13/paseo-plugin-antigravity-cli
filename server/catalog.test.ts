import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID, addAccount, setActive } from "./accounts";
import { parseModels } from "./catalog";
import { installFakeSecurity, type FakeSecurity } from "./testing/fake-security";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));

const originalHome = process.env.HOME;
const originalPaseoHome = process.env.PASEO_HOME;

let tempDir: string;
/** The daemon's home: the real one every account shadow home mirrors. */
let home: string;
let paseoHome: string;
let envFile: string;
/** Accounts are added here, so the shadow-home sync must never reach the real `/usr/bin/security`. */
let security: FakeSecurity;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-catalog-"));
  home = join(tempDir, "home");
  paseoHome = join(tempDir, "paseo-home");
  envFile = join(tempDir, "env.json");
  mkdirSync(home, { recursive: true });
  // Repointed per test: HOME so a Default `agy models` runs under this test's real home, PASEO_HOME
  // so the account store and the caches of the plugin never touch the developer's own data.
  process.env.HOME = home;
  process.env.PASEO_HOME = paseoHome;
  chmodSync(fakeAgy, 0o755);
  process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
  delete process.env.FAKE_MODELS_OK;
  delete process.env.FAKE_MODELS_LOG;
  delete process.env.FAKE_ENV_FILE;
  // Each case needs a cold module cache so the model list is discovered again; the tests then use
  // dynamic imports for the same reason, since a static one would keep the first case's cache.
  vi.resetModules();
  // Installed after the reset: the static `./accounts` this file's `addAccount` comes from is the
  // one that gets the fake, and the dynamically imported catalog only reads account paths.
  security = installFakeSecurity("linux");
});

afterEach(() => {
  security.restore();
  for (const key of ["PASEO_ANTIGRAVITY_BIN", "FAKE_MODELS_LOG", "FAKE_MODELS_OK", "FAKE_ENV_FILE"]) {
    delete process.env[key];
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  rmSync(tempDir, { recursive: true, force: true });
});

/** The shadow home of an account created by these tests, as `server/accounts.ts` lays it out. */
function shadowHome(id: string): string {
  return join(paseoHome, "plugin-data", "antigravity-cli", "accounts", id, "home");
}

/** The `HOME` the last `agy` run recorded, which is how a test tells the accounts apart. */
function launchedHome(): string | null | undefined {
  const recorded: unknown = JSON.parse(readFileSync(envFile, "utf8"));
  if (typeof recorded !== "object" || recorded === null || !("HOME" in recorded)) return undefined;
  const value = recorded.HOME;
  return typeof value === "string" ? value : null;
}

describe("parseModels", () => {
  it("reads the tab separated slug and label pairs", () => {
    expect(
      parseModels("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nfake-model-x\tFake Model X\n"),
    ).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", isDefault: true },
      { id: "fake-model-x", label: "Fake Model X", isDefault: false },
    ]);
  });

  it("skips the progress banner and any line that is not a model row", () => {
    const output = [
      "Fetching available models...",
      "",
      "   ",
      "no-tab-separator",
      "\tMissing slug",
      "missing-label\t",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
      "claude-opus-4-6-thinking\tDuplicate row",
      "not a valid slug!\tBad",
    ].join("\n");

    expect(parseModels(output)).toEqual([
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", isDefault: false },
    ]);
  });

  it("returns nothing for empty output so the caller can fall back", () => {
    expect(parseModels("")).toEqual([]);
    expect(parseModels("Fetching available models...\n")).toEqual([]);
  });
});

describe("catalog cache", () => {
  function modelsRuns(logPath: string): number {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  }

  it("keys on the binary path and its modification time", async () => {
    const first = join(tempDir, "agy-a");
    const second = join(tempDir, "agy-b");
    copyFileSync(fakeAgy, first);
    copyFileSync(fakeAgy, second);
    const { catalogCacheKey } = await import("./catalog");

    const key = catalogCacheKey(DEFAULT_ACCOUNT_ID, first);
    expect(key).toContain(first);
    expect(catalogCacheKey(DEFAULT_ACCOUNT_ID, second)).not.toBe(key);

    // A CLI update rewrites the binary, so the build identity is part of the key.
    utimesSync(first, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(catalogCacheKey(DEFAULT_ACCOUNT_ID, first)).not.toBe(key);
  });

  it("discovers models again when the binary changes, and when a caller forces it", async () => {
    process.env.FAKE_MODELS_OK = "1";
    const logPath = join(tempDir, "models.log");
    process.env.FAKE_MODELS_LOG = logPath;
    const first = join(tempDir, "agy-a");
    const second = join(tempDir, "agy-b");
    copyFileSync(fakeAgy, first);
    copyFileSync(fakeAgy, second);
    const { buildCatalog, catalogCacheKey } = await import("./catalog");

    await buildCatalog(DEFAULT_ACCOUNT_ID, first);
    await buildCatalog(DEFAULT_ACCOUNT_ID, first);
    expect(modelsRuns(logPath)).toBe(1);

    // A different binary may report a different list, so it must not be served from the cache.
    await buildCatalog(DEFAULT_ACCOUNT_ID, second);
    expect(modelsRuns(logPath)).toBe(2);

    const { createProvider } = await import("./provider");
    const registration = createProvider();
    expect(await registration.getCatalogCacheKey?.({ scope: "global" })).toBe(
      catalogCacheKey(DEFAULT_ACCOUNT_ID),
    );

    // An explicit refresh bypasses our cache as well as the daemon's.
    await registration.getCatalogCacheKey?.({ scope: "global", force: true });
    await buildCatalog(DEFAULT_ACCOUNT_ID, second);
    expect(modelsRuns(logPath)).toBe(3);
  });

  it("keeps a list per account, runs `agy models` under each home, and keys Paseo on the active one", async () => {
    process.env.FAKE_MODELS_OK = "1";
    process.env.FAKE_ENV_FILE = envFile;
    const logPath = join(tempDir, "models.log");
    process.env.FAKE_MODELS_LOG = logPath;
    addAccount("Work");
    const { buildCatalog, catalogCacheKey, currentModels } = await import("./catalog");

    // Default is the real home and spawns with today's env: no HOME is invented for it.
    await buildCatalog(DEFAULT_ACCOUNT_ID);
    expect(launchedHome()).toBe(home);
    expect(modelsRuns(logPath)).toBe(1);
    await buildCatalog(DEFAULT_ACCOUNT_ID);
    expect(modelsRuns(logPath)).toBe(1);

    // A different account means a different `$HOME`, so the list has to be discovered again.
    await buildCatalog("work");
    expect(launchedHome()).toBe(shadowHome("work"));
    expect(modelsRuns(logPath)).toBe(2);

    // Switching back is served from Default's own entry, not a rediscovery or the bare fallback.
    await buildCatalog(DEFAULT_ACCOUNT_ID);
    expect(modelsRuns(logPath)).toBe(2);
    expect(currentModels(DEFAULT_ACCOUNT_ID).map((model) => model.id)).toContain("fake-model-x");
    expect(currentModels("work").map((model) => model.id)).toContain("fake-model-x");
    // An account that was never discovered has no entry of its own: the bundled list stands in.
    expect(currentModels("personal").map((model) => model.id)).not.toContain("fake-model-x");

    // The account is part of Paseo's rediscovery key, so switching accounts triggers a discovery
    // there too; the same account and binary keeps the key stable.
    addAccount("Personal");
    const { createProvider } = await import("./provider");
    const registration = createProvider();
    const asDefault = await registration.getCatalogCacheKey?.({ scope: "global" });
    expect(asDefault).toBe(catalogCacheKey(DEFAULT_ACCOUNT_ID));
    expect(catalogCacheKey("work")).not.toBe(asDefault);

    setActive("work");
    expect(await registration.getCatalogCacheKey?.({ scope: "global" })).toBe(
      catalogCacheKey("work"),
    );
  });

  it("falls back to the bundled list for an account whose `agy models` fails", async () => {
    addAccount("Work");
    // Dynamic import, as everywhere in this file: the catalog cache is module state that the
    // `vi.resetModules()` above is what clears between cases.
    const { FALLBACK_MODELS, buildCatalog } = await import("./catalog");

    const catalog = await buildCatalog("work");

    // A signed-out account (or any other failure) is exactly a failing `agy models`: the bundled
    // list, discovered rows never having existed.
    expect(catalog.models.map((model) => model.id)).toEqual(
      FALLBACK_MODELS.map((model) => model.id),
    );
    expect(catalog.models.map((model) => model.id)).not.toContain("fake-model-x");
  });
});

describe("buildCatalog", () => {
  it("groups the tiers the CLI reports into one model with thinking options", async () => {
    process.env.FAKE_MODELS_OK = "1";
    const { buildCatalog } = await import("./catalog");

    const catalog = await buildCatalog(DEFAULT_ACCOUNT_ID);

    // Every `<family>-high|medium|low` row becomes one model; the tier suffix becomes the option.
    expect(catalog.models.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
      "fake-model-x",
    ]);
    expect(catalog.defaultModel).toBe("gemini-3.8-flash");
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["default", "accept-edits", "plan"]);
    // The axis is per model, so the catalog carries no list of its own.
    expect(catalog.thinkingOptions).toEqual([]);
    expect(catalog.defaultMode).toBe("default");

    const flash = catalog.models.find((model) => model.id === "gemini-3.8-flash");
    expect(flash).toMatchObject({
      label: "Gemini 3.8 Flash",
      isDefault: true,
      defaultThinkingOptionId: "high",
      thinkingOptions: [
        { id: "high", label: "High", isDefault: true },
        { id: "medium", label: "Medium", isDefault: false },
        { id: "low", label: "Low", isDefault: false },
      ],
    });
    // A family with two tiers keeps them in `agy models` order; `high` stays the default.
    expect(catalog.models.find((model) => model.id === "gemini-3.1-pro")).toMatchObject({
      thinkingOptions: [{ id: "high" }, { id: "low" }],
      defaultThinkingOptionId: "high",
    });
    // A tier suffix with no sibling is part of the id, and a model without one has no tiers.
    expect(catalog.models.find((model) => model.id === "gpt-oss-120b-medium")).not.toHaveProperty(
      "thinkingOptions",
    );
    const opus = catalog.models.find((model) => model.id === "claude-opus-4-6-thinking");
    expect(opus).not.toHaveProperty("thinkingOptions");
  });

  it("falls back to the bundled list when the CLI cannot list models", async () => {
    const { buildCatalog } = await import("./catalog");

    const catalog = await buildCatalog(DEFAULT_ACCOUNT_ID);

    // The bundled list is grouped exactly like a discovered one.
    expect(catalog.models.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(catalog.models.map((model) => model.id)).toContain("claude-opus-4-6-thinking");
    expect(catalog.models.filter((model) => model.isDefault)).toHaveLength(1);
    // The fallback must still expose the modes the composer needs.
    expect(catalog.modes.map((mode) => mode.id)).toContain("plan");
  });
});

describe("resolveThinking", () => {
  it("resolves a tier choice and a persisted full slug to the same slug the CLI accepts", async () => {
    const { resolveThinking } = await import("./catalog");

    // The family plus an explicit tier.
    expect(resolveThinking("gemini-3.8-flash", "low", DEFAULT_ACCOUNT_ID)).toMatchObject({
      slug: "gemini-3.8-flash-low",
      option: "low",
    });
    // No option: the family's default tier.
    expect(resolveThinking("gemini-3.8-flash", undefined, DEFAULT_ACCOUNT_ID)).toMatchObject({
      slug: "gemini-3.8-flash-high",
      option: "high",
    });
    // A slug persisted before tiers existed launches unchanged, and reports its own tier.
    expect(resolveThinking("gemini-3.8-flash-high", undefined, DEFAULT_ACCOUNT_ID)).toMatchObject({
      slug: "gemini-3.8-flash-high",
      option: "high",
    });
    // A tier chosen afterwards replaces the slug's own tier.
    expect(resolveThinking("gemini-3.8-flash-high", "medium", DEFAULT_ACCOUNT_ID)).toMatchObject({
      slug: "gemini-3.8-flash-medium",
      option: "medium",
    });
    // A stale option the model does not have is ignored rather than invented into a slug.
    expect(resolveThinking("gemini-3.1-pro", "low", DEFAULT_ACCOUNT_ID).slug).toBe("gemini-3.1-pro-low");
    expect(resolveThinking("gemini-3.1-pro", "medium", DEFAULT_ACCOUNT_ID).slug).toBe("gemini-3.1-pro-high");
    expect(resolveThinking("claude-sonnet-4-6", "high", DEFAULT_ACCOUNT_ID)).toEqual({
      slug: "claude-sonnet-4-6",
      options: [],
    });
    // `-medium` here belongs to the id, so no tier may be appended or substituted.
    expect(resolveThinking("gpt-oss-120b-medium", "high", DEFAULT_ACCOUNT_ID)).toMatchObject({
      slug: "gpt-oss-120b-medium",
      options: [],
    });
    expect(resolveThinking(undefined, "high", DEFAULT_ACCOUNT_ID)).toEqual({ options: [] });
  });

  it("handles max reasoning effort tier", async () => {
    const { groupModels, parseModels, resolveThinking } = await import("./catalog");
    const parsed = parseModels(
      "custom-model-max\tCustom Model (Max)\ncustom-model-high\tCustom Model (High)\ncustom-model-low\tCustom Model (Low)\n",
    );
    const grouped = groupModels(parsed);
    expect(grouped).toEqual([
      {
        id: "custom-model",
        label: "Custom Model",
        isDefault: false,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "max", label: "Max", isDefault: false },
          { id: "high", label: "High", isDefault: true },
          { id: "low", label: "Low", isDefault: false },
        ],
      },
    ]);
  });
});
