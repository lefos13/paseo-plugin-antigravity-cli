import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readSettingsFile } from "./agysettings";
import { pluginDataDir } from "./plugindata";

/**
 * Antigravity resolves its config root as `$HOME/.gemini` and nothing else moves it (the hidden
 * `--gemini_dir` flag is not used: it is unofficial). An account is therefore a *shadow home*:
 * every top-level entry of the real home is a symlink to it, `.gemini` is a real directory that
 * mirrors the shared parts of the real `~/.gemini` as links, and everything `agy` creates there —
 * the token, history, brain — stays per account.
 *
 * `agy` loads and saves its sign-in through the macOS login Keychain (go-keyring runs
 * `/usr/bin/security`) and finds that keychain through `$HOME/Library/Keychains`. Each shadow home
 * therefore gets a Keychain of its own rather than a way to reach the real one: `Library` is a real
 * directory mirroring every child except `Keychains`, and `Library/Preferences` is a real one too,
 * minus `com.apple.security.plist` — a real search-list file must never point the account back at
 * the login keychain. On every sync `ensureAccountKeychain` creates `Library/Keychains/
 * account.keychain-db` if it is missing, makes it the shadow home's default keychain and unlocks
 * it, because a locked keychain makes `agy` pop a password dialog. The real home's Keychain and
 * search list are never linked, read or written.
 *
 * `antigravity-cli/settings.json` is the one shared file that is copied instead of linked: `agy`
 * writes it with an atomic replace, which a symlink does not survive. `addAccount` seeds the copy
 * from the real file, a sync converts an older account that still has a link, and a real file is
 * kept as it is.
 *
 * The plugin process's own `HOME` is never touched: `os.homedir()` follows it, and every shared
 * read (skills, MCP config, settings) must keep seeing the real home. Only the spawned `agy` gets
 * `HOME=<shadow home>` in its environment.
 *
 * The `Default` account is the real home itself: no directory, no override, not removable.
 */

export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_ACCOUNT_NAME = "Default";

/**
 * Shadow homes cannot separate accounts on Windows, so only Default exists there. Probed with agy
 * 1.2.16: it ignores `HOME` and resolves `.gemini` from `USERPROFILE`, and it keeps the sign-in in
 * Windows Credential Manager under the single target `gemini:antigravity`, whatever the home — two
 * accounts would share one token, and signing one in would sign the other out. Creating the
 * shadow home's links also needs Developer Mode or an elevated daemon.
 */
export function multiAccountSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export interface Account {
  id: string;
  name: string;
}

/** Persisted shape of `accounts.json`; `accounts` never contains Default. */
export interface AccountsState {
  active: string;
  accounts: Account[];
}

const STATE_VERSION = 1;
/** One slug, one directory under `accounts/`: no id may escape that directory. */
const ACCOUNT_ID = /^[a-z0-9-]+$/;
const GEMINI_DIR = ".gemini";
/** One directory of the mirror: the children to leave out, and the children that get their own tree. */
interface MirrorSpec {
  readonly exclude: readonly string[];
  readonly partial: Readonly<Record<string, MirrorSpec>>;
}

/**
 * The shadow home's mirror of the real home. `Library` is nested so its `Preferences` becomes a
 * real directory: a `com.apple.security.plist` written into a shadow home could otherwise point
 * `security` — and therefore `agy` — back at the real login keychain.
 */
const HOME_MIRROR: MirrorSpec = {
  exclude: [GEMINI_DIR],
  partial: {
    Library: {
      exclude: ["Keychains"],
      partial: {
        Preferences: { exclude: ["com.apple.security.plist"], partial: {} },
      },
    },
  },
};

/**
 * What the shadow home's `.gemini` holds as links to the real one. `config` carries MCP servers,
 * plugins and `config/skills`; `skills` and `antigravity-cli/skills` are the two global skill
 * roots; `agents` the global agent profiles. Everything else under `.gemini` is the account's own.
 *
 * `antigravity-cli/settings.json` is deliberately absent: `agy` replaces that file atomically, so a
 * link would be broken the first time it writes a setting and the account would silently lose it.
 * Each account keeps its own copy instead, seeded from the real file (`syncSettingsFile`).
 *
 * The links are created even when the real counterpart does not exist yet: `agy` creates the
 * target lazily through the link, so a fresh install with no `config/` still ends up sharing it.
 */
const GEMINI_LINKS: ReadonlyArray<{
  readonly path: readonly string[];
  readonly target: readonly string[];
  readonly kind: "dir" | "file";
}> = [
  { path: ["config"], target: [GEMINI_DIR, "config"], kind: "dir" },
  { path: ["skills"], target: [GEMINI_DIR, "skills"], kind: "dir" },
  {
    path: ["antigravity-cli", "skills"],
    target: [GEMINI_DIR, "antigravity-cli", "skills"],
    kind: "dir",
  },
  {
    path: ["antigravity-cli", "agents"],
    target: [GEMINI_DIR, "antigravity-cli", "agents"],
    kind: "dir",
  },
];

/** The settings file relative to a `.gemini` root; the plugin reads and edits it, nothing else. */
const SETTINGS_RELATIVE = join("antigravity-cli", "settings.json");

/**
 * Every failure — missing file, unparsable JSON, an entry of the wrong shape, an id that could
 * escape `accounts/` — leaves the plugin with Default only, never with an error a spawn cannot
 * recover from.
 */
export function readAccounts(): AccountsState {
  // A store copied from another machine must not route a spawn into a shadow home that cannot work.
  if (!multiAccountSupported()) return { active: DEFAULT_ACCOUNT_ID, accounts: [] };
  const stored = readStateFile();
  const accounts: Account[] = [];
  const seen = new Set<string>([DEFAULT_ACCOUNT_ID]);
  for (const entry of stored.accounts) {
    const account = toAccount(entry);
    if (account === null || seen.has(account.id)) continue;
    seen.add(account.id);
    accounts.push(account);
  }
  const active = seen.has(stored.active) ? stored.active : DEFAULT_ACCOUNT_ID;
  return { active, accounts };
}

/** Default first, then the stored accounts in the order they were added. */
export function listAccounts(): Account[] {
  return [
    { id: DEFAULT_ACCOUNT_ID, name: DEFAULT_ACCOUNT_NAME },
    ...readAccounts().accounts,
  ];
}

export function setActive(id: string): void {
  const state = readAccounts();
  if (id !== DEFAULT_ACCOUNT_ID && !state.accounts.some((account) => account.id === id)) {
    throw new Error(`Unknown account: ${id}`);
  }
  // Rewrites the normalized state, so a hand-edited file is repaired on the way through.
  writeState({ active: id, accounts: state.accounts });
}

/**
 * Creates the account's shadow home and records it. The directory comes first: a failure to
 * create it must not leave an account in the store whose home is missing.
 */
export function addAccount(name: string): Account {
  if (!multiAccountSupported()) {
    throw new Error("Multiple accounts are not supported on Windows: agy keeps one sign-in per Windows user");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("An account needs a name");
  const id = slugify(trimmed);
  if (id.length === 0) {
    throw new Error(`"${trimmed}" has no letters, digits or dashes to build an account id from`);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    throw new Error(`"${trimmed}" is reserved for the Default account`);
  }
  const state = readAccounts();
  if (state.accounts.some((account) => account.id === id)) {
    throw new Error(`An account named "${trimmed}" already exists`);
  }

  writeShadowLinks(shadowHomePath(id));
  const account: Account = { id, name: trimmed };
  writeState({ active: state.active, accounts: [...state.accounts, account] });
  return account;
}

/**
 * Deletes the account's own directory and nothing else. `rmSync` unlinks the shadow home's
 * symlinks instead of following them, so the real home and `~/.gemini` survive untouched (the
 * test suite proves it with sentinels behind every link).
 */
export function removeAccount(id: string): void {
  if (id === DEFAULT_ACCOUNT_ID) throw new Error("The Default account cannot be removed");
  const state = readAccounts();
  if (!state.accounts.some((account) => account.id === id)) {
    throw new Error(`Unknown account: ${id}`);
  }
  rmSync(pluginDataDir("accounts", id), { recursive: true, force: true });
  writeState({
    active: state.active === id ? DEFAULT_ACCOUNT_ID : state.active,
    accounts: state.accounts.filter((account) => account.id !== id),
  });
}

/** `null` for Default, which is the real home and has no shadow of its own. */
export function accountHome(id: string): string | null {
  return id === DEFAULT_ACCOUNT_ID ? null : shadowHomePath(id);
}

/** Where `agy` looks for its config: the real `~/.gemini` for Default, the shadow's for the rest. */
export function accountGeminiRoot(id: string): string {
  const home = accountHome(id);
  return home === null ? join(homedir(), GEMINI_DIR) : join(home, GEMINI_DIR);
}

/**
 * Idempotent (re)creation of the links an account's shadow home mirrors, run before every spawn:
 * a real entry added since the last spawn gets its link, a link whose real entry has gone is
 * removed. Anything a tool wrote inside the shadow home itself is a real entry and is left alone —
 * it shadows the real one for this account — which is logged rather than overwritten.
 */
export function syncShadowHome(id: string): void {
  if (id === DEFAULT_ACCOUNT_ID) return;
  requireStoredAccount(id);
  writeShadowLinks(shadowHomePath(id));
}

/** The shadow home's path; the caller already knows the id is a real, non-Default one. */
function shadowHomePath(id: string): string {
  if (!ACCOUNT_ID.test(id)) throw new Error(`Invalid account id: ${id}`);
  return pluginDataDir("accounts", id, "home");
}

function writeShadowLinks(home: string): void {
  const real = homedir();

  mkdirSync(home, { recursive: true });
  mirrorDir(home, real, HOME_MIRROR);

  const gemini = join(home, GEMINI_DIR);
  mkdirSync(gemini, { recursive: true });
  for (const link of GEMINI_LINKS) {
    linkEntry(join(gemini, ...link.path), join(real, ...link.target), link.kind);
  }
  syncSettingsFile(home);
  ensureAccountKeychain(home);
}

/** `/usr/bin/security`, the executable `agy`'s keyring backend runs. */
const SECURITY = "/usr/bin/security";
/** A keychain operation either answers at once or is not worth the spawn's wait. */
const SECURITY_TIMEOUT_MS = 10_000;

/** Injected by the tests; the defaults are the real platform and `/usr/bin/security`. */
export interface KeychainRuntime {
  platform: NodeJS.Platform;
  run: (args: readonly string[], env: NodeJS.ProcessEnv) => void;
}

function runSecurity(args: readonly string[], env: NodeJS.ProcessEnv): void {
  execFileSync(SECURITY, args, { env, stdio: "ignore", timeout: SECURITY_TIMEOUT_MS });
}

let keychainRuntime: KeychainRuntime = { platform: process.platform, run: runSecurity };

/** The tests replace both fields; `null` restores the real platform and `/usr/bin/security`. */
export function setKeychainRuntime(runtime: KeychainRuntime | null): void {
  keychainRuntime = runtime ?? { platform: process.platform, run: runSecurity };
}

/**
 * The per-account Keychain. Deliberately not `login.keychain-db`: `security unlock-keychain` treats
 * that basename as the user's real login keychain (probed: exit 51, "passphrase not correct", even
 * with the right password), so the account keychain gets its own name and is made the default
 * through the shadow home's own `Library/Preferences/com.apple.security.plist`.
 */
export function accountKeychainPath(home: string): string {
  return join(home, "Library", "Keychains", "account.keychain-db");
}

/**
 * Gives the shadow home a Keychain of its own. `security default-keychain -s` with `HOME=<shadow>`
 * writes `<shadow>/Library/Preferences/com.apple.security.plist` (probed: the real home's
 * preferences, default keychain and search list stay unchanged), which the mirror keeps as the
 * account's own real file, so `agy`'s keyring load and save stay inside the account. A missing
 * keychain is created with an empty password and no auto-lock. Every sync re-asserts the default
 * and unlocks, because a locked keychain blocks `agy` behind a password dialog.
 *
 * darwin only. No failure is fatal: a spawn without a keychain still works and merely shows that
 * dialog, so every step is logged and skipped. `HOME` is set on the call's env, never on
 * `process.env`, so `/usr/bin/security` can only ever see the shadow home.
 */
function ensureAccountKeychain(home: string): void {
  if (keychainRuntime.platform !== "darwin") return;
  const path = accountKeychainPath(home);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(home, "Library", "Preferences"), { recursive: true });
  const env = { ...process.env, HOME: home };
  const steps: ReadonlyArray<readonly string[]> = [
    ...(existsSync(path)
      ? []
      : [
          ["create-keychain", "-p", "", path],
          ["set-keychain-settings", path],
        ]),
    ["default-keychain", "-s", path],
    ["unlock-keychain", "-p", "", path],
  ];
  for (const args of steps) {
    try {
      keychainRuntime.run(args, env);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[antigravity] security ${args[0]} failed for ${home}: ${reason}`);
    }
  }
}

/**
 * Keeps this account's `settings.json` a real file of its own.
 *
 * `agy` writes the settings with an atomic replace, so a link to the real file is broken the first
 * time the CLI saves a setting — and the account silently keeps using the value it read before.
 * An account configured while this file was still linked is converted here, from the content the
 * link points at, so nothing the account had is lost. A real file is what an account is supposed to
 * have now, whether `agy` or the accounts screen wrote it, so it is left alone and not even logged.
 */
function syncSettingsFile(home: string): void {
  const path = join(home, GEMINI_DIR, SETTINGS_RELATIVE);
  const current = statOrNull(path);
  if (current?.isSymbolicLink()) {
    let content: Buffer | null = null;
    try {
      // Read through the link before removing it: the copy has to hold what the account was using.
      content = readFileSync(path);
    } catch {
      // A dangling link: the real file is gone, so there is nothing to copy from it.
    }
    rmSync(path, { force: true });
    if (content !== null) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return;
    }
  } else if (current) {
    return;
  }

  let seed: Buffer | null = null;
  try {
    seed = readFileSync(join(homedir(), GEMINI_DIR, SETTINGS_RELATIVE));
  } catch {
    // No real settings file yet: `agy` writes its own defaults on its first run.
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, seed);
}

/** The two settings the accounts screen owns; every other key of the file belongs to `agy`. */
export interface AccountSettings {
  toolPermission: string | null;
  trustedWorkspaces: string[];
}

/**
 * What the account's own `settings.json` holds. Default reads the real file, which is the one `agy`
 * maintains. A file that is missing or unusable is not an error: both values are simply unknown,
 * which is what the composer and the trust check would show anyway.
 */
export function readAccountSettings(id: string): AccountSettings {
  if (id !== DEFAULT_ACCOUNT_ID) requireStoredAccount(id);
  const settings = readSettingsFile(accountGeminiRoot(id));
  const permission = settings?.toolPermission;
  const trusted = settings?.trustedWorkspaces;
  return {
    toolPermission:
      typeof permission === "string" && permission.trim().length > 0 ? permission.trim() : null,
    trustedWorkspaces: Array.isArray(trusted)
      ? trusted.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

/**
 * Sets `toolPermission` and/or `trustedWorkspaces` on an account's own settings file, leaving every
 * other key — `agy`'s own preferences — untouched. Default is refused: its file is managed by the
 * CLI. The write goes through a temp file in the same directory and a rename, so a crash cannot
 * leave a half-written settings file that `agy` would then refuse to parse.
 */
export function updateAccountSettings(
  id: string,
  patch: { toolPermission?: string; trustedWorkspaces?: readonly string[] },
): void {
  if (id === DEFAULT_ACCOUNT_ID) {
    throw new Error("The Default account's settings are managed by agy and cannot be edited here");
  }
  requireStoredAccount(id);
  if (patch.toolPermission !== undefined && typeof patch.toolPermission !== "string") {
    throw new Error("toolPermission must be a string");
  }
  if (patch.trustedWorkspaces !== undefined && !Array.isArray(patch.trustedWorkspaces)) {
    throw new Error("trustedWorkspaces must be an array of paths");
  }

  // A legacy link becomes the account's own copy first, so the patch lands in a file `agy` cannot
  // break; a missing file is seeded from the real one, which keeps the account's baseline.
  syncSettingsFile(shadowHomePath(id));
  const root = accountGeminiRoot(id);
  const path = join(root, SETTINGS_RELATIVE);
  const settings = readSettingsFile(root);
  if (settings === null && statOrNull(path) !== null) {
    throw new Error(`Refusing to overwrite ${path}: it is not a JSON object`);
  }

  const next: Record<string, unknown> = { ...(settings ?? {}) };
  if (patch.toolPermission !== undefined) next.toolPermission = patch.toolPermission;
  if (patch.trustedWorkspaces !== undefined) next.trustedWorkspaces = [...patch.trustedWorkspaces];

  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

/** `dir`/`file` only decides how the link is recorded on Windows; both are plain links on unix. */
function linkEntry(linkPath: string, target: string, kind: "dir" | "file"): void {
  const current = statOrNull(linkPath);
  if (current) {
    if (!current.isSymbolicLink()) {
      console.error(
        `[antigravity] ${linkPath} is a real ${kind === "dir" ? "directory" : "file"}, not a link to ${target}; keeping it`,
      );
      return;
    }
    if (readlinkSync(linkPath) === target) return;
    // Stale link, pointing at a home or a path this account no longer mirrors. Unlinking a link
    // never touches what it points at.
    rmSync(linkPath, { force: true });
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, kind);
}

/**
 * Mirrors `real` into `shadow` as links, minus `spec.exclude`. A directory named in `spec.partial`
 * becomes a real directory mirrored the same way, so a link that once stood in its place is
 * replaced. A dangling link is dropped first: its real entry is gone, so nothing would replace it
 * and it would keep `~/.gitconfig` (and every other name) resolving to nothing. A link under an
 * excluded name is dropped too, so an excluded entry never stays reachable; a real entry there is
 * the account's own and is kept.
 */
function mirrorDir(shadow: string, real: string, spec: MirrorSpec): void {
  for (const entry of readdirSync(shadow)) {
    const link = join(shadow, entry);
    if (!statOrNull(link)?.isSymbolicLink()) continue;
    if (spec.exclude.includes(entry) || !existsSync(link)) rmSync(link, { force: true });
  }

  for (const entry of readdirSync(real)) {
    if (spec.exclude.includes(entry)) continue;
    const source = join(real, entry);
    const info = statOrNull(source, true);
    // A broken link in the real home mirrors nothing.
    if (info === null) continue;
    const target = join(shadow, entry);
    const nested = spec.partial[entry];
    if (nested !== undefined && info.isDirectory()) {
      // Unlinking a link never touches what it points at.
      if (statOrNull(target)?.isSymbolicLink()) rmSync(target, { force: true });
      mkdirSync(target, { recursive: true });
      mirrorDir(target, source, nested);
      continue;
    }
    linkEntry(target, source, info.isDirectory() ? "dir" : "file");
  }
}

function requireStoredAccount(id: string): Account {
  const account = readAccounts().accounts.find((candidate) => candidate.id === id);
  if (!account) throw new Error(`Unknown account: ${id}`);
  return account;
}

/** `Ada Lovelace` -> `ada-lovelace`: the id is also the directory name, so it is a slug of the name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toAccount(value: unknown): Account | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  if (typeof id !== "string" || !ACCOUNT_ID.test(id) || id === DEFAULT_ACCOUNT_ID) return null;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  return { id, name: name.trim() };
}

function readStateFile(): { active: string; accounts: unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pluginDataDir("accounts.json"), "utf8"));
  } catch {
    // Missing or unparsable: Default only, exactly as on a first run.
    return { active: DEFAULT_ACCOUNT_ID, accounts: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { active: DEFAULT_ACCOUNT_ID, accounts: [] };
  }
  const record = parsed as Record<string, unknown>;
  return {
    active: typeof record.active === "string" ? record.active : DEFAULT_ACCOUNT_ID,
    accounts: Array.isArray(record.accounts) ? record.accounts : [],
  };
}

/** Written through a temp file in the same directory, so a crash cannot truncate the state. */
function writeState(state: AccountsState): void {
  const path = pluginDataDir("accounts.json");
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify(
      { version: STATE_VERSION, active: state.active, accounts: state.accounts },
      null,
      2,
    )}\n`,
    "utf8",
  );
  renameSync(temp, path);
}

/** The entry's own metadata, or `null` when it does not exist; `follow` looks through a link. */
function statOrNull(path: string, follow = false): Stats | null {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch {
    return null;
  }
}
