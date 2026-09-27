import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  accountGeminiRoot,
  accountHome,
  addAccount,
  listAccounts,
  readAccountSettings,
  readAccounts,
  removeAccount,
  setActive,
  syncShadowHome,
  updateAccountSettings,
} from "./accounts";
import { installFakeSecurity, type FakeSecurity } from "./testing/fake-security";

const originalHome = process.env.HOME;
const originalPaseoHome = process.env.PASEO_HOME;

let root: string;
/** The real home: the account shadow homes mirror it and must never be able to hurt it. */
let home: string;
let paseoHome: string;
/** The fake `/usr/bin/security`: the suite must never run the real one. */
let security: FakeSecurity;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-accounts-"));
  home = join(root, "home");
  paseoHome = join(root, "paseo-home");
  mkdirSync(home, { recursive: true });
  // Both are repointed per test: the real home by HOME, the store by PASEO_HOME.
  process.env.HOME = home;
  process.env.PASEO_HOME = paseoHome;
  security = installFakeSecurity();
});

afterEach(() => {
  security.restore();
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  rmSync(root, { recursive: true, force: true });
});

function shadow(id: string): string {
  return join(paseoHome, "plugin-data", "antigravity-cli", "accounts", id, "home");
}

const statePath = (): string => join(paseoHome, "plugin-data", "antigravity-cli", "accounts.json");

function writeStateFile(value: unknown): void {
  mkdirSync(join(paseoHome, "plugin-data", "antigravity-cli"), { recursive: true });
  writeFileSync(statePath(), typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

/** What a shadow entry is, without following it: `link -> target`, `dir` or `file`. */
function kind(path: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return `link -> ${readlinkSync(path)}`;
  if (info.isDirectory()) return "dir";
  return "file";
}

/** Every path under `dir`, with a symlink's target and a file's content: a tamper detector. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(`link ${path} -> ${readlinkSync(path)}`);
      continue;
    }
    if (entry.isDirectory()) {
      found.push(`dir ${path}`);
      found.push(...walk(path));
      continue;
    }
    found.push(`file ${path}: ${readFileSync(path, "utf8")}`);
  }
  return found;
}

/** A real home with one entry of every kind the shadow home has to mirror. */
function seedRealHome(): void {
  const gemini = join(home, ".gemini");
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Real\n", "utf8");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "SENTINEL-SSH\n", "utf8");
  // `agy` finds the login Keychain here; the shadow home must never reach it.
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  writeFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "SENTINEL-KEYCHAIN\n", "utf8");
  mkdirSync(join(home, "Library", "Preferences"), { recursive: true });
  writeFileSync(join(home, "Library", "Preferences", "tool.plist"), "SENTINEL-PREFS\n", "utf8");
  // The search list: a file that names the keychains `security` may use, and must never be mirrored.
  writeFileSync(
    join(home, "Library", "Preferences", "com.apple.security.plist"),
    "SENTINEL-SEARCH-LIST\n",
    "utf8",
  );
  mkdirSync(join(gemini, "config", "plugins", "demo"), { recursive: true });
  writeFileSync(join(gemini, "config", "mcp_config.json"), '{"mcpServers":{}}', "utf8");
  writeFileSync(join(gemini, "config", "plugins", "demo", "plugin.json"), "{}", "utf8");
  mkdirSync(join(gemini, "skills", "shared-skill"), { recursive: true });
  writeFileSync(join(gemini, "skills", "shared-skill", "SKILL.md"), "SENTINEL-ROOT-SKILL\n", "utf8");
  const cli = join(gemini, "antigravity-cli");
  mkdirSync(join(cli, "skills", "global-skill"), { recursive: true });
  writeFileSync(join(cli, "skills", "global-skill", "SKILL.md"), "SENTINEL-CLI-SKILL\n", "utf8");
  mkdirSync(join(cli, "agents"), { recursive: true });
  writeFileSync(join(cli, "agents", "judge.md"), "SENTINEL-AGENT\n", "utf8");
  writeFileSync(
    join(cli, "settings.json"),
    JSON.stringify({ toolPermission: "request-review" }),
    "utf8",
  );
  // The account's own state, the kind of file `agy` writes into a shadow home.
  mkdirSync(join(cli, "brain", "conv-1"), { recursive: true });
  writeFileSync(join(cli, "brain", "conv-1", "transcript.jsonl"), "SENTINEL-BRAIN\n", "utf8");
}

describe("account state", () => {
  it("reads Default only when accounts.json is missing", () => {
    expect(readAccounts()).toEqual({ active: DEFAULT_ACCOUNT_ID, accounts: [] });
    expect(listAccounts()).toEqual([{ id: DEFAULT_ACCOUNT_ID, name: "Default" }]);
  });

  it("reads Default only when accounts.json cannot be parsed", () => {
    writeStateFile("{ not json");
    expect(readAccounts()).toEqual({ active: DEFAULT_ACCOUNT_ID, accounts: [] });
  });

  it("falls back to Default when the stored active account is gone", () => {
    writeStateFile({
      version: 1,
      active: "personal",
      accounts: [{ id: "work", name: "Work" }],
    });

    expect(readAccounts()).toEqual({
      active: DEFAULT_ACCOUNT_ID,
      accounts: [{ id: "work", name: "Work" }],
    });
  });

  it("drops stored ids that could leave the accounts directory", () => {
    writeStateFile({
      version: 1,
      active: "ok-name",
      accounts: [
        { id: "../../../../tmp/evil", name: "Evil" },
        { id: "ok-name", name: "OK" },
        { id: "Default", name: "Not Default" },
      ],
    });

    expect(listAccounts()).toEqual([
      { id: DEFAULT_ACCOUNT_ID, name: "Default" },
      { id: "ok-name", name: "OK" },
    ]);
  });

  it("acts on the stored accounts and refuses an unknown one", () => {
    addAccount("Work");
    expect(() => setActive("personal")).toThrow(/Unknown account: personal/);
    expect(() => removeAccount("personal")).toThrow(/Unknown account: personal/);

    setActive("work");
    expect(readAccounts().active).toBe("work");
    setActive(DEFAULT_ACCOUNT_ID);
    expect(readAccounts().active).toBe(DEFAULT_ACCOUNT_ID);

    // Rewritten through a temp file in the same directory, which must not be left behind.
    const dir = join(paseoHome, "plugin-data", "antigravity-cli");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("addAccount", () => {
  it("slugs the name into the id and lists Default first", () => {
    seedRealHome();
    const account = addAccount("  Work  2026! (Personal) ");

    expect(account).toEqual({ id: "work-2026-personal", name: "Work  2026! (Personal)" });
    expect(accountHome(account.id)).toBe(shadow(account.id));
    expect(listAccounts()).toEqual([
      { id: DEFAULT_ACCOUNT_ID, name: "Default" },
      account,
    ]);
  });

  it("rejects an empty name, a slug that is empty, Default, and a duplicate id", () => {
    expect(() => addAccount("   ")).toThrow(/needs a name/);
    expect(() => addAccount("!!!")).toThrow(/no letters, digits or dashes/);
    expect(() => addAccount("Default")).toThrow(/reserved/);

    addAccount("Work");
    expect(() => addAccount("Work")).toThrow(/already exists/);
    // A different spelling of the same slug is the same directory, so it is a duplicate too.
    expect(() => addAccount("work!")).toThrow(/already exists/);
  });

  it("never records an account whose home could not be created", () => {
    // A file where the accounts directory belongs: creating the home fails, so nothing is stored.
    mkdirSync(join(paseoHome, "plugin-data", "antigravity-cli"), { recursive: true });
    writeFileSync(join(paseoHome, "plugin-data", "antigravity-cli", "accounts"), "", "utf8");

    expect(() => addAccount("Work")).toThrow();
    expect(readAccounts().accounts).toEqual([]);
  });
});

describe("shadow home", () => {
  it("links every top-level real entry except .gemini and mirrors the shared .gemini parts", () => {
    seedRealHome();
    addAccount("Work");
    const account = shadow("work");

    expect(kind(join(account, ".gitconfig"))).toBe(`link -> ${join(home, ".gitconfig")}`);
    expect(kind(join(account, ".ssh"))).toBe(`link -> ${join(home, ".ssh")}`);
    // `.gemini` itself is the account's own directory, not a link: the token and history live here.
    expect(kind(join(account, ".gemini"))).toBe("dir");

    const gemini = join(account, ".gemini");
    expect(kind(join(gemini, "config"))).toBe(`link -> ${join(home, ".gemini", "config")}`);
    expect(kind(join(gemini, "skills"))).toBe(`link -> ${join(home, ".gemini", "skills")}`);
    expect(kind(join(gemini, "antigravity-cli"))).toBe("dir");
    expect(kind(join(gemini, "antigravity-cli", "skills"))).toBe(
      `link -> ${join(home, ".gemini", "antigravity-cli", "skills")}`,
    );
    expect(kind(join(gemini, "antigravity-cli", "agents"))).toBe(
      `link -> ${join(home, ".gemini", "antigravity-cli", "agents")}`,
    );
    // The one shared file that is copied, not linked: `agy` replaces it with an atomic write.
    expect(kind(join(gemini, "antigravity-cli", "settings.json"))).toBe("file");
    expect(readFileSync(join(gemini, "antigravity-cli", "settings.json"), "utf8")).toBe(
      JSON.stringify({ toolPermission: "request-review" }),
    );

    // Everything the CLI keeps per account is absent until `agy` creates it, and reading through a
    // link reaches the real file: that is the whole point of the mirror.
    expect(existsSync(join(gemini, "antigravity-cli", "brain"))).toBe(false);
    expect(readFileSync(join(gemini, "config", "mcp_config.json"), "utf8")).toBe('{"mcpServers":{}}');
    expect(readFileSync(join(gemini, "skills", "shared-skill", "SKILL.md"), "utf8")).toBe(
      "SENTINEL-ROOT-SKILL\n",
    );
    expect(existsSync(join(gemini, "antigravity-cli", "builtin"))).toBe(false);

    // Nothing else was invented in either directory the account owns.
    expect(readdirSync(gemini).sort()).toEqual(["antigravity-cli", "config", "skills"]);
    expect(readdirSync(join(gemini, "antigravity-cli")).sort()).toEqual([
      "agents",
      "settings.json",
      "skills",
    ]);
  });

  it("keeps the login Keychain and its search list out of reach and mirrors the rest of Library", () => {
    seedRealHome();
    addAccount("Work");
    const library = join(shadow("work"), "Library");

    // Every Library child is a link except the two that could reach the real Keychain: `Keychains`
    // becomes the account's own directory and `Preferences` its own directory minus the search list.
    expect(kind(library)).toBe("dir");
    expect(kind(join(library, "Keychains"))).toBe("dir");
    expect(kind(join(library, "Preferences"))).toBe("dir");
    expect(kind(join(library, "Preferences", "tool.plist"))).toBe(
      `link -> ${join(home, "Library", "Preferences", "tool.plist")}`,
    );
    expect(existsSync(join(library, "Preferences", "com.apple.security.plist"))).toBe(false);

    // An account created before this rule had `Library` as one link, an older one had `Preferences`
    // as one too: both become real directories on the next sync, the real Library untouched.
    rmSync(library, { recursive: true, force: true });
    symlinkSync(join(home, "Library"), library, "dir");
    syncShadowHome("work");
    expect(kind(library)).toBe("dir");
    expect(kind(join(library, "Preferences"))).toBe("dir");
    expect(existsSync(join(library, "Preferences", "com.apple.security.plist"))).toBe(false);

    rmSync(join(library, "Preferences"), { recursive: true, force: true });
    symlinkSync(join(home, "Library", "Preferences"), join(library, "Preferences"), "dir");
    syncShadowHome("work");
    expect(kind(join(library, "Preferences"))).toBe("dir");
    expect(kind(join(library, "Preferences", "tool.plist"))).toBe(
      `link -> ${join(home, "Library", "Preferences", "tool.plist")}`,
    );
    expect(existsSync(join(library, "Preferences", "com.apple.security.plist"))).toBe(false);

    // A stray link under an excluded name does not survive either.
    rmSync(join(library, "Keychains"), { recursive: true, force: true });
    symlinkSync(join(home, "Library", "Keychains"), join(library, "Keychains"), "dir");
    syncShadowHome("work");
    expect(kind(join(library, "Keychains"))).toBe("dir");

    // Nothing the account did ever reached the real files behind those names.
    expect(readFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "utf8")).toBe(
      "SENTINEL-KEYCHAIN\n",
    );
    expect(readFileSync(join(home, "Library", "Preferences", "com.apple.security.plist"), "utf8")).toBe(
      "SENTINEL-SEARCH-LIST\n",
    );
  });

  it("creates the account's own Keychain on the first sync and only re-asserts it afterwards", () => {
    seedRealHome();
    addAccount("Work");
    const account = shadow("work");
    // Not `login.keychain-db`: `security unlock-keychain` maps that name to the real login keychain.
    const path = join(account, "Library", "Keychains", "account.keychain-db");

    expect(security.calls.map((call) => call.args)).toEqual([
      ["create-keychain", "-p", "", path],
      ["set-keychain-settings", path],
      ["default-keychain", "-s", path],
      ["unlock-keychain", "-p", "", path],
    ]);
    // Every call carried the shadow home, never the real one.
    expect(security.calls.map((call) => call.home)).toEqual([account, account, account, account]);

    // `default-keychain -s` writes the account's own search list; the mirror must keep that real file.
    const searchList = join(account, "Library", "Preferences", "com.apple.security.plist");
    writeFileSync(searchList, "ACCOUNT-SEARCH-LIST\n", "utf8");
    security.calls.length = 0;
    syncShadowHome("work");
    expect(security.calls.map((call) => call.args)).toEqual([
      ["default-keychain", "-s", path],
      ["unlock-keychain", "-p", "", path],
    ]);
    expect(security.calls.every((call) => call.home === account)).toBe(true);
    expect(kind(searchList)).toBe("file");
    expect(readFileSync(searchList, "utf8")).toBe("ACCOUNT-SEARCH-LIST\n");
  });

  it("touches no Keychain off macOS", () => {
    seedRealHome();
    security.restore();
    security = installFakeSecurity("linux");
    addAccount("Work");
    syncShadowHome("work");

    expect(security.calls).toEqual([]);
    expect(existsSync(join(shadow("work"), "Library", "Keychains"))).toBe(false);
  });

  it("keeps syncing when every security call fails", () => {
    seedRealHome();
    security.failWith(new Error("keychain is busy"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    addAccount("Work");
    syncShadowHome("work");

    // Each of the four steps is attempted and logged, and the rest of the mirror still happened.
    expect(security.calls.map((call) => call.args[0])).toEqual([
      "create-keychain",
      "set-keychain-settings",
      "default-keychain",
      "unlock-keychain",
      "create-keychain",
      "set-keychain-settings",
      "default-keychain",
      "unlock-keychain",
    ]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("unlock-keychain failed"));
    expect(kind(join(shadow("work"), ".gemini"))).toBe("dir");
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("SENTINEL"));
  });

  it("creates the .gemini links even when the real counterpart does not exist yet", () => {
    addAccount("Work");
    const gemini = join(shadow("work"), ".gemini");

    for (const relative of ["config", "skills", join("antigravity-cli", "skills")]) {
      const link = join(gemini, relative);
      expect(kind(link)).toBe(`link -> ${join(home, ".gemini", relative)}`);
      expect(existsSync(link)).toBe(false);
    }
    // Nothing to seed from, so no settings file either: `agy` writes its own on the first run.
    expect(existsSync(join(gemini, "antigravity-cli", "settings.json"))).toBe(false);
  });

  it("adds a link for a real entry created later and drops a link whose entry vanished", () => {
    addAccount("Work");
    const account = shadow("work");
    expect(existsSync(join(account, ".npmrc"))).toBe(false);

    writeFileSync(join(home, ".npmrc"), "registry=https://example.test\n", "utf8");
    syncShadowHome("work");
    expect(kind(join(account, ".npmrc"))).toBe(`link -> ${join(home, ".npmrc")}`);

    rmSync(join(home, ".npmrc"));
    syncShadowHome("work");
    expect(existsSync(join(account, ".npmrc"))).toBe(false);
    // The mirror is idempotent: the fixed links are still there, with the same targets.
    expect(kind(join(account, ".gemini", "config"))).toBe(`link -> ${join(home, ".gemini", "config")}`);
  });

  it("keeps a real entry a tool wrote in the shadow home and logs it instead of overwriting", () => {
    seedRealHome();
    addAccount("Work");
    const account = shadow("work");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    rmSync(join(account, ".gitconfig"));
    writeFileSync(join(account, ".gitconfig"), "[user]\n\tname = Account\n", "utf8");
    syncShadowHome("work");

    expect(kind(join(account, ".gitconfig"))).toBe("file");
    expect(readFileSync(join(account, ".gitconfig"), "utf8")).toBe("[user]\n\tname = Account\n");
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe("[user]\n\tname = Real\n");
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(join(account, ".gitconfig")),
    );
  });

  it("gives each account its own copy of settings.json and leaves the real file alone", () => {
    seedRealHome();
    addAccount("Work");
    const accountFile = join(shadow("work"), ".gemini", "antigravity-cli", "settings.json");
    const realFile = join(home, ".gemini", "antigravity-cli", "settings.json");
    const realBefore = readFileSync(realFile);

    // Seeded: the account starts with exactly what the real file held.
    expect(readFileSync(accountFile)).toEqual(realBefore);

    writeFileSync(accountFile, JSON.stringify({ toolPermission: "turbo" }), "utf8");
    syncShadowHome("work");

    expect(kind(accountFile)).toBe("file");
    expect(readFileSync(accountFile, "utf8")).toBe(JSON.stringify({ toolPermission: "turbo" }));
    // The account is what changed: the file `agy` owns outside Paseo is byte-identical.
    expect(readFileSync(realFile)).toEqual(realBefore);
  });

  it("converts a linked settings.json into a copy of the real file on sync", () => {
    seedRealHome();
    addAccount("Work");
    const accountFile = join(shadow("work"), ".gemini", "antigravity-cli", "settings.json");
    const realFile = join(home, ".gemini", "antigravity-cli", "settings.json");
    const realBefore = readFileSync(realFile);
    // An account created while this file was still linked has exactly the old shape.
    rmSync(accountFile);
    symlinkSync(realFile, accountFile);

    syncShadowHome("work");

    expect(kind(accountFile)).toBe("file");
    expect(readFileSync(accountFile)).toEqual(realBefore);
    expect(readFileSync(realFile)).toEqual(realBefore);

    // From then on the account edits its own copy, which the real file never sees.
    writeFileSync(accountFile, JSON.stringify({ toolPermission: "turbo" }), "utf8");
    syncShadowHome("work");
    expect(readFileSync(realFile)).toEqual(realBefore);
  });

  it("keeps an account settings file `agy` replaced atomically, without logging", () => {
    seedRealHome();
    addAccount("Work");
    const accountFile = join(shadow("work"), ".gemini", "antigravity-cli", "settings.json");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // What `agy` does when it saves a setting: a temp file renamed over the target.
    const temp = `${accountFile}.agy-tmp`;
    writeFileSync(temp, JSON.stringify({ toolPermission: "agent-decides" }), "utf8");
    renameSync(temp, accountFile);

    syncShadowHome("work");

    expect(kind(accountFile)).toBe("file");
    expect(readFileSync(accountFile, "utf8")).toBe(
      JSON.stringify({ toolPermission: "agent-decides" }),
    );
    expect(errors).not.toHaveBeenCalled();
  });

  it("answers the config root per account and refuses to sync an unknown or Default one", () => {
    expect(accountHome(DEFAULT_ACCOUNT_ID)).toBeNull();
    expect(accountGeminiRoot(DEFAULT_ACCOUNT_ID)).toBe(join(home, ".gemini"));

    addAccount("Work");
    expect(accountGeminiRoot("work")).toBe(join(shadow("work"), ".gemini"));

    expect(() => syncShadowHome("personal")).toThrow(/Unknown account: personal/);
    // Default is the real home: there is no shadow home to create.
    syncShadowHome(DEFAULT_ACCOUNT_ID);
    expect(existsSync(join(paseoHome, "plugin-data", "antigravity-cli", "accounts", "default"))).toBe(
      false,
    );
  });
});

describe("removeAccount", () => {
  it("deletes only the account directory, leaving everything behind a link untouched", () => {
    seedRealHome();
    addAccount("Work");
    const account = shadow("work");
    // What only this account may lose: its own state, and a file a tool wrote into its home.
    mkdirSync(join(account, ".gemini", "antigravity-cli", "brain"), { recursive: true });
    writeFileSync(join(account, ".gemini", "antigravity-cli", "brain", "own.jsonl"), "OWN\n", "utf8");
    writeFileSync(join(account, ".zsh_history"), "OWN-HISTORY\n", "utf8");

    const before = walk(home);
    removeAccount("work");

    expect(walk(home)).toEqual(before);
    expect(readFileSync(join(home, ".ssh", "id_ed25519"), "utf8")).toBe("SENTINEL-SSH\n");
    expect(readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8")).toBe(
      JSON.stringify({ toolPermission: "request-review" }),
    );
    // The two names the mirror keeps away from every account are byte-identical to before.
    expect(readFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "utf8")).toBe(
      "SENTINEL-KEYCHAIN\n",
    );
    expect(
      readFileSync(join(home, "Library", "Preferences", "com.apple.security.plist"), "utf8"),
    ).toBe("SENTINEL-SEARCH-LIST\n");
    expect(existsSync(join(paseoHome, "plugin-data", "antigravity-cli", "accounts", "work"))).toBe(
      false,
    );
  });

  it("falls back to Default when the active account is removed", () => {
    addAccount("Work");
    addAccount("Personal");
    setActive("personal");

    removeAccount("personal");

    expect(readAccounts()).toEqual({
      active: DEFAULT_ACCOUNT_ID,
      accounts: [{ id: "work", name: "Work" }],
    });
    // Removing an account that is not active leaves the active one alone.
    setActive("work");
    removeAccount("work");
    expect(readAccounts()).toEqual({ active: DEFAULT_ACCOUNT_ID, accounts: [] });
  });

  it("refuses to remove Default", () => {
    expect(() => removeAccount(DEFAULT_ACCOUNT_ID)).toThrow(/Default account cannot be removed/);
  });
});

describe("account settings", () => {
  const realFile = () => join(home, ".gemini", "antigravity-cli", "settings.json");
  const accountFile = (id: string) =>
    join(shadow(id), ".gemini", "antigravity-cli", "settings.json");

  it("reads the two editable values from the account's own file, tolerating what it cannot use", () => {
    seedRealHome();
    addAccount("Work");
    // The real file moves on without the account, which is the point of the copy.
    writeFileSync(
      realFile(),
      JSON.stringify({
        toolPermission: "always-proceed",
        trustedWorkspaces: [home, "/srv/other"],
        theme: "dark",
      }),
      "utf8",
    );

    expect(readAccountSettings("work")).toEqual({
      toolPermission: "request-review",
      trustedWorkspaces: [],
    });
    // Default reads the real file, the one `agy` maintains.
    expect(readAccountSettings(DEFAULT_ACCOUNT_ID)).toEqual({
      toolPermission: "always-proceed",
      trustedWorkspaces: [home, "/srv/other"],
    });

    // A file that is not JSON, holds the wrong types, or is gone reads as unknown, never throwing.
    writeFileSync(accountFile("work"), "{ not json", "utf8");
    expect(readAccountSettings("work")).toEqual({ toolPermission: null, trustedWorkspaces: [] });
    writeFileSync(
      accountFile("work"),
      JSON.stringify({ toolPermission: 7, trustedWorkspaces: ["/srv/code", 3, null] }),
      "utf8",
    );
    expect(readAccountSettings("work")).toEqual({
      toolPermission: null,
      trustedWorkspaces: ["/srv/code"],
    });
    rmSync(accountFile("work"));
    expect(readAccountSettings("work")).toEqual({ toolPermission: null, trustedWorkspaces: [] });

    // An id that is not a stored account is a caller bug, not an empty reading.
    expect(() => readAccountSettings("personal")).toThrow(/Unknown account: personal/);
  });

  it("updates an account's settings, preserving every other key and refusing Default", () => {
    seedRealHome();
    addAccount("Work");
    // What `agy` itself keeps in the account's file, none of which the accounts screen owns.
    writeFileSync(
      accountFile("work"),
      JSON.stringify({ toolPermission: "request-review", theme: "dark", nested: { a: 1 } }),
      "utf8",
    );
    const realBefore = readFileSync(realFile());

    updateAccountSettings("work", {
      toolPermission: "turbo",
      trustedWorkspaces: [home, "/srv/code"],
    });

    expect(JSON.parse(readFileSync(accountFile("work"), "utf8"))).toEqual({
      toolPermission: "turbo",
      trustedWorkspaces: [home, "/srv/code"],
      theme: "dark",
      nested: { a: 1 },
    });
    expect(readFileSync(realFile())).toEqual(realBefore);

    // A patch with one value leaves the other exactly as it was.
    updateAccountSettings("work", { toolPermission: "agent-decides" });
    expect(readAccountSettings("work")).toEqual({
      toolPermission: "agent-decides",
      trustedWorkspaces: [home, "/srv/code"],
    });

    expect(() => updateAccountSettings(DEFAULT_ACCOUNT_ID, { toolPermission: "turbo" })).toThrow(
      /Default account's settings are managed by agy/,
    );
    expect(() => updateAccountSettings("personal", { toolPermission: "turbo" })).toThrow(
      /Unknown account: personal/,
    );
    // Types are checked instead of being written into a file `agy` would then refuse to parse.
    expect(() =>
      updateAccountSettings("work", { toolPermission: 7 as unknown as string }),
    ).toThrow(/toolPermission must be a string/);
    expect(() =>
      updateAccountSettings("work", { trustedWorkspaces: "/srv/code" as unknown as string[] }),
    ).toThrow(/trustedWorkspaces must be an array/);

    // The atomic write leaves no temp file behind, and the refused calls changed nothing.
    expect(
      readdirSync(join(shadow("work"), ".gemini", "antigravity-cli")).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    expect(readAccountSettings("work")).toEqual({
      toolPermission: "agent-decides",
      trustedWorkspaces: [home, "/srv/code"],
    });
  });

  it("creates the file of an account that has none, and refuses to overwrite a corrupt one", () => {
    // No real settings file either: there is nothing to seed the account from.
    addAccount("Work");

    updateAccountSettings("work", { trustedWorkspaces: ["/srv/code"] });

    expect(JSON.parse(readFileSync(accountFile("work"), "utf8"))).toEqual({
      trustedWorkspaces: ["/srv/code"],
    });

    writeFileSync(accountFile("work"), "{ not json", "utf8");
    expect(() => updateAccountSettings("work", { toolPermission: "turbo" })).toThrow(
      /not a JSON object/,
    );
    // The unreadable file is left for the user to fix instead of being silently replaced.
    expect(readFileSync(accountFile("work"), "utf8")).toBe("{ not json");
  });
});
