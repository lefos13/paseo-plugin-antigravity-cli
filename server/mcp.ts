import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parseAgyJson } from "./agysettings";
import { pluginDataDir } from "./plugindata";

/**
 * Opt-in sharing of Paseo's MCP servers with the CLI. Antigravity reads MCP servers from
 * `<dir>/.agents/mcp_config.json` for every directory it was given (probed 2026-09-23: a workspace
 * file in a `--add-dir` directory was loaded, and the model called the tool through
 * `call_mcp_tool` with `{ServerName, ToolName}`; `agy mcp list` only lists the user's global
 * config, so a workspace file never shows up there). The global file lives at
 * `~/.gemini/config/mcp_config.json` and is never touched by this plugin.
 *
 * Entries the plugin writes are named `paseo-<server>` and tracked in a ledger, because the file
 * also holds the user's own servers and is not the plugin's to clear.
 */

/** `config.mcpServers` as Paseo passes it. agy has no sse transport, so both URL kinds map alike. */
export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Readonly<Record<string, string>>;
    };

/** One `mcpServers` entry in agy's own format, with the alphabetical key order it writes. */
export interface AgyMcpEntry {
  args?: string[];
  command?: string;
  disabled: false;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  serverUrl?: string;
}

export const PASEO_MCP_PREFIX = "paseo-";

/** Where agy looks for a directory's own MCP servers. */
export function mcpConfigPath(cwd: string): string {
  return join(cwd, ".agents", "mcp_config.json");
}

/** One `mcpServers` entry as agy writes it: `disabled` is always present. */
export function toAgyEntry(server: McpServerConfig): AgyMcpEntry {
  if (server.type !== "stdio") {
    return {
      disabled: false,
      ...(server.headers ? { headers: { ...server.headers } } : {}),
      serverUrl: server.url,
    };
  }
  return {
    ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
    command: server.command,
    disabled: false,
    ...(server.env ? { env: { ...server.env } } : {}),
  };
}

export type InjectionResult =
  | { status: "written"; path: string; entries: string[] }
  | { status: "unchanged"; path: string; entries: string[] }
  | { status: "invalid"; path: string }
  | { status: "failed"; path: string; message: string };

/**
 * The file agy reads is the user's, so only the fields this plugin needs are read and everything
 * else round-trips untouched. A file that is not a JSON object is reported, never overwritten.
 */
const configFileSchema = z.record(z.string(), z.unknown());
const serverMapSchema = z.record(z.string(), z.unknown());

/**
 * The two lines the plugin appends to a repository's `info/exclude`, remembered so a release can
 * take exactly those back and nothing else.
 */
const gitExcludeSchema = z.object({
  /** Absolute path to the repository's `info/exclude`, in the git dir its worktrees share. */
  file: z.string(),
  /** The repository-relative pattern, e.g. `/.agents/mcp_config.json`. */
  pattern: z.string(),
});

const ledgerSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(
    z.string(),
    z.object({
      /** Whether the plugin created the file, which is what allows deleting it again. */
      created: z.boolean(),
      /**
       * Whether the plugin created the `.agents` directory itself. Only then may an empty one be
       * removed again; a directory the user had is never the plugin's to take away. Missing in a
       * ledger written before this field existed, which reads as "not ours".
       */
      createdDir: z.boolean().default(false),
      /** Entry name to the sessions that contributed it, so the last one out removes it. */
      entries: z.record(z.string(), z.array(z.string())),
      /**
       * The `info/exclude` lines the plugin added to keep this file out of the user's commits, if
       * it added any. Missing in a ledger written before this field existed, which reads as
       * "nothing was excluded".
       */
      gitExclude: gitExcludeSchema.optional(),
    }),
  ),
});

type Ledger = z.infer<typeof ledgerSchema>;
type LedgerWorkspace = Ledger["workspaces"][string];

/**
 * Adds this session's servers to the workspace config and records ownership. The file is only
 * rewritten when its content changes, so two sessions in one directory share it without churn.
 */
export async function injectMcpServers(options: {
  cwd: string;
  sessionId: string;
  servers: Readonly<Record<string, McpServerConfig>>;
}): Promise<InjectionResult> {
  const path = mcpConfigPath(options.cwd);
  const named: Record<string, AgyMcpEntry> = {};
  for (const [name, server] of Object.entries(options.servers)) {
    named[`${PASEO_MCP_PREFIX}${name}`] = toAgyEntry(server);
  }
  const entries = Object.keys(named).sort();

  return serialize(async () => {
    const current = await readConfigFile(path);
    if (current.kind === "invalid") {
      console.error(`[antigravity] ${path} is not valid JSON; leaving it untouched`);
      return { status: "invalid", path } as const;
    }

    // Ownership is recorded first: a write that fails must still leave a record, or the entries
    // would outlive the session with nothing pointing at them.
    const ledger = await readLedger();
    const workspace = (ledger.workspaces[options.cwd] ??= {
      created: current.kind === "missing",
      // The plugin creates `.agents` when it is not there, and takes it away again only then.
      createdDir: !(await directoryExists(dirname(path))),
      entries: {},
    });
    for (const name of entries) {
      const sessions = workspace.entries[name] ?? [];
      if (!sessions.includes(options.sessionId)) sessions.push(options.sessionId);
      workspace.entries[name] = sessions;
    }
    await writeLedger(ledger);

    const root = current.kind === "parsed" ? current.root : {};
    const servers = serverMapSchema.safeParse(root.mcpServers).data ?? {};
    const text = `${JSON.stringify({ ...root, mcpServers: { ...servers, ...named } }, null, 2)}\n`;
    const unchanged = current.kind === "parsed" && current.raw === text;
    if (!unchanged) {
      try {
        await mkdir(dirname(path), { recursive: true });
        // The entries carry whatever credentials Paseo's servers use (headers, env), so a file the
        // plugin creates is private to the user.
        await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        const message = describe(error);
        console.error(`[antigravity] could not write ${path}: ${message}`);
        return { status: "failed", path, message } as const;
      }
      console.log(`[antigravity] wrote ${entries.length} MCP entr(ies) to ${path}`);
    }

    // Those credentials must not reach a commit. This runs whenever the file holds the plugin's
    // entries — written now, or found already written by a session in this directory — because the
    // exclude line is the only thing standing between the token and the user's next `git add .`.
    const excluded = await addGitExclude(options.cwd, path);
    if (
      excluded !== null &&
      (workspace.gitExclude?.file !== excluded.file || workspace.gitExclude.pattern !== excluded.pattern)
    ) {
      workspace.gitExclude = excluded;
      await writeLedger(ledger);
    }
    return unchanged
      ? ({ status: "unchanged", path, entries } as const)
      : ({ status: "written", path, entries } as const);
  });
}

/**
 * Drops every entry this session contributed, removing an entry once no other session uses it and
 * deleting the file only when the plugin created it and nothing of the user's is left in it.
 */
export async function releaseMcpServers(sessionId: string): Promise<void> {
  await dropUnreferencedEntries((id) => id !== sessionId);
}

/**
 * Removes entries left behind by a process that died before it could release them: anything the
 * ledger attributes only to sessions that are no longer open. Runs on `session.open`, where the
 * set of live sessions is known.
 */
export async function sweepMcpLedger(liveSessions: ReadonlySet<string>): Promise<void> {
  await dropUnreferencedEntries((id) => liveSessions.has(id));
}

/** Drops the sessions `keep` rejects from every entry, then removes the entries left unowned. */
async function dropUnreferencedEntries(keep: (sessionId: string) => boolean): Promise<void> {
  await serialize(async () => {
    const ledger = await readLedger();
    const doomed = new Map<string, string[]>();
    let changed = false;
    for (const [cwd, workspace] of Object.entries(ledger.workspaces)) {
      for (const [name, sessions] of Object.entries(workspace.entries)) {
        const remaining = sessions.filter(keep);
        if (remaining.length === sessions.length) continue;
        changed = true;
        if (remaining.length > 0) {
          workspace.entries[name] = remaining;
          continue;
        }
        delete workspace.entries[name];
        doomed.set(cwd, [...(doomed.get(cwd) ?? []), name]);
      }
    }
    if (!changed) return;
    for (const [cwd, names] of doomed) await removeEntries(cwd, names, ledger);
    await writeLedger(ledger);
  });
}

/**
 * Deletes the named entries from a workspace's file and forgets the workspace when nothing is left
 * in it. A file that cannot be read as an object is left alone: the ledger still points at the
 * entries, so a later session there tries again rather than losing the record.
 */
async function removeEntries(cwd: string, names: readonly string[], ledger: Ledger): Promise<void> {
  const workspace: LedgerWorkspace | undefined = ledger.workspaces[cwd];
  const path = mcpConfigPath(cwd);
  const current = await readConfigFile(path);
  if (current.kind === "parsed") {
    const servers = { ...(serverMapSchema.safeParse(current.root.mcpServers).data ?? {}) };
    for (const name of names) delete servers[name];
    const root = { ...current.root, mcpServers: servers };
    if (workspace?.created && Object.keys(root).every((key) => key === "mcpServers") && Object.keys(servers).length === 0) {
      await rm(path, { force: true });
    } else {
      await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    }
  }
  if (workspace && Object.keys(workspace.entries).length === 0) {
    delete ledger.workspaces[cwd];
    // Nothing of this plugin's is left here, so the exclude it added has nothing left to hide.
    if (workspace.gitExclude) await removeGitExclude(workspace.gitExclude);
    // An `.agents` directory the plugin created itself is now empty again — unless the user keeps
    // something else in it, which keeps the directory.
    if (workspace.createdDir) await removeDirectoryIfEmpty(dirname(path));
  }
}

/** Removes a directory the plugin created, and only while nothing else has landed in it. */
async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // Not empty, or already gone: either way it is not the plugin's to remove.
  }
}

/** Whether the directory is already there, which is what decides if an empty one may be removed. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Opens a comment on a line of its own, and names the pattern it belongs to, so the plugin can
 * recognise its own lines without guessing at the rest of the file. `info/exclude` has no comment
 * syntax at the end of a line — `/.agents/mcp_config.json  # …` is one long pattern, which
 * `git check-ignore` confirms by not matching the file — so a trailing marker would silently stop
 * excluding anything.
 */
const EXCLUDE_MARKER = "# added by paseo antigravity-cli plugin";

/** A hung or missing `git` must not hold up a session; excluding is best-effort housekeeping. */
const GIT_TIMEOUT_MS = 5_000;

type GitExclude = z.infer<typeof gitExcludeSchema>;

/**
 * Keeps the shared config — Paseo's own bearer token among its entries — out of the user's commits.
 * A clone's `info/exclude` is the only ignore file a plugin may write: it is untracked, so nothing
 * the user shares changes, while `git add .` treats it exactly like `.gitignore`. Appends twice
 * never, once, and only when the pattern is not already there for some other reason.
 */
async function addGitExclude(cwd: string, path: string): Promise<GitExclude | null> {
  const repo = await resolveRepo(cwd);
  if (repo === null) return null;

  // git prints paths it has already resolved, so the workspace side is resolved too before the
  // two are compared: `/var/…` and `/private/var/…` are the same directory but not the same string.
  const configDir = await realpath(dirname(path)).catch(() => dirname(path));
  const rel = relative(repo.toplevel, join(configDir, "mcp_config.json"));
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    console.log(`[antigravity] ${path} is outside the work tree at ${repo.toplevel}; it stays visible to git`);
    return null;
  }
  const pattern = `/${rel.split(sep).join("/")}`;
  const file = join(repo.commonDir, "info", "exclude");
  const marker = `${EXCLUDE_MARKER}: ${pattern}`;
  const raw = await readText(file);
  const lines = raw === null ? [] : raw.split("\n");
  if (lines.some((line) => line.trim() === marker)) return { file, pattern };
  if (lines.some((line) => line.trim() === pattern)) {
    // Someone else's line already covers it, so there is nothing to add and nothing to take back.
    console.log(`[antigravity] ${pattern} is already excluded in ${file}; leaving that line alone`);
    return null;
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    // Appending to a file whose last line has no newline must not glue the two lines together.
    const prefix = raw === null || raw.length === 0 || raw.endsWith("\n") ? (raw ?? "") : `${raw}\n`;
    await writeFile(file, `${prefix}${marker}\n${pattern}\n`, "utf8");
  } catch (error) {
    console.error(`[antigravity] could not exclude ${pattern} in ${file}: ${describe(error)}`);
    return null;
  }
  console.log(`[antigravity] excluded ${pattern} in ${file}`);
  return { file, pattern };
}

/** Drops the marker and the pattern line under it, and leaves every other line where it is. */
async function removeGitExclude(record: GitExclude): Promise<void> {
  const raw = await readText(record.file);
  if (raw === null) return;
  const marker = `${EXCLUDE_MARKER}: ${record.pattern}`;
  const lines = raw.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== marker) {
      kept.push(lines[index] ?? "");
      continue;
    }
    // The pattern is the plugin's only while it is still the line the marker introduces.
    if (lines[index + 1]?.trim() === record.pattern) index += 1;
  }
  const text = kept.join("\n");
  if (text === raw) return;
  try {
    await writeFile(record.file, text, "utf8");
  } catch (error) {
    console.error(`[antigravity] could not remove the exclude line in ${record.file}: ${describe(error)}`);
  }
}

/**
 * The repository a directory belongs to, in git's own terms: the root of its work tree, and the
 * *common* git dir, which is the one that holds `info/exclude` for a linked worktree as well as for
 * the main checkout (both `git worktree add` and a `.git` file point at it).
 */
async function resolveRepo(cwd: string): Promise<{ toplevel: string; commonDir: string } | null> {
  let stdout: string;
  try {
    stdout = await runGit(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  } catch (error) {
    console.log(`[antigravity] no git work tree for ${cwd} (${describe(error)}); the MCP config stays visible to git`);
    return null;
  }
  const [toplevel, common] = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (toplevel === undefined || common === undefined) return null;
  // `--git-common-dir` comes back relative to the directory git ran in, which git resolved itself.
  const realCwd = await realpath(cwd).catch(() => cwd);
  return { toplevel, commonDir: resolve(realCwd, common) };
}

/** `git` bounded by a timeout, because a session's launch waits on this. */
async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { promise, resolve: settle, reject: fail } = Promise.withResolvers<string>();
  execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
    if (error) fail(error);
    else settle(stdout);
  });
  return promise;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ConfigFile =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "parsed"; raw: string; root: Record<string, unknown> };

async function readConfigFile(path: string): Promise<ConfigFile> {
  const raw = await readText(path);
  if (raw === null) return { kind: "missing" };
  const parsed = configFileSchema.safeParse(safeJson(raw));
  return parsed.success ? { kind: "parsed", raw, root: parsed.data } : { kind: "invalid" };
}

/** A file the plugin does not own: a failed read and unparseable JSON are both "no data". */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function safeJson(raw: string): unknown {
  try {
    return parseAgyJson(raw);
  } catch {
    return null;
  }
}

async function readLedger(): Promise<Ledger> {
  const path = pluginDataDir("mcp-ledger.json");
  const raw = await readText(path);
  if (raw === null) return { version: 1, workspaces: {} };
  const parsed = ledgerSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    console.error(`[antigravity] ignoring an unreadable MCP ledger at ${path}`);
    return { version: 1, workspaces: {} };
  }
  return parsed.data;
}

async function writeLedger(ledger: Ledger): Promise<void> {
  const path = pluginDataDir("mcp-ledger.json");
  try {
    await mkdir(dirname(path), { recursive: true });
    // No secrets here, only paths and ids; 0600 anyway, next to the files that do hold some.
    await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error(`[antigravity] could not write ${path}: ${describe(error)}`);
  }
}

/**
 * The ledger is one file shared by every session in the connection, so read-modify-write runs one
 * operation at a time; without it, two sessions opening together could drop each other's entries.
 */
let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = pending.then(operation, operation);
  pending = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
