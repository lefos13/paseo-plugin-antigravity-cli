import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectMcpServers, mcpConfigPath, releaseMcpServers, sweepMcpLedger } from "./mcp";

const SERVERS = {
  fs: { type: "stdio", command: "node", args: ["-e", "1"], env: { K: "V" } },
  api: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer T" } },
} as const;

let root: string;
let cwd: string;
let configPath: string;
let ledgerPath: string;
const originalPaseoHome = process.env.PASEO_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-mcp-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  configPath = mcpConfigPath(cwd);
  process.env.PASEO_HOME = join(root, "paseo-home");
  ledgerPath = join(root, "paseo-home", "plugin-data", "antigravity-cli", "mcp-ledger.json");
});

afterEach(() => {
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  rmSync(root, { recursive: true, force: true });
});

function readConfig(): { mcpServers: Record<string, unknown> } & Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
}

describe("workspace MCP config", () => {
  it("writes agy's entry format for stdio and http servers", async () => {
    const result = await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });

    expect(result).toMatchObject({ status: "written", entries: ["paseo-api", "paseo-fs"] });
    // The exact shape `agy mcp add` produced in the spike: serverUrl for a URL, command/args/env
    // for a process, and `disabled` on both.
    expect(readConfig()).toEqual({
      mcpServers: {
        "paseo-api": { disabled: false, headers: { Authorization: "Bearer T" }, serverUrl: "https://example.com/mcp" },
        "paseo-fs": { args: ["-e", "1"], command: "node", disabled: false, env: { K: "V" } },
      },
    });
    // The entries carry credentials, so the file the plugin creates is not world-readable.
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual({
      version: 1,
      workspaces: {
        [cwd]: { created: true, createdDir: true, entries: { "paseo-api": ["s1"], "paseo-fs": ["s1"] } },
      },
    });
  });

  it("leaves the user's own entries and root keys as they were", async () => {
    const original = `${JSON.stringify(
      { mcpServers: { github: { args: ["serve"], command: "gh-mcp", disabled: false } }, telemetry: true },
      null,
      2,
    )}\n`;
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(configPath, original, "utf8");

    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    expect(readConfig().mcpServers.github).toEqual({ args: ["serve"], command: "gh-mcp", disabled: false });
    expect(readConfig().telemetry).toBe(true);

    await releaseMcpServers("s1");
    // The user's file is theirs: only the plugin's entries leave, and the rest is unchanged.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(ledgerPath)).toBe(true);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces).toEqual({});
  });

  it("merges into a config that starts with a UTF-8 byte order mark", async () => {
    // agy 1.3.1 loads such a file (Notepad, PowerShell `Set-Content`), so the plugin must not
    // refuse it as invalid and launch without Paseo's servers.
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(configPath, `\uFEFF${JSON.stringify({ mcpServers: { mine: { serverUrl: "https://x" } } })}`, "utf8");

    expect(await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS })).toMatchObject({
      status: "written",
    });
    expect(Object.keys(readConfig().mcpServers).sort()).toEqual(["mine", "paseo-api", "paseo-fs"]);
  });

  it("refuses to touch a config that is not valid JSON", async () => {
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(configPath, "{ this is not json", "utf8");

    expect(await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS })).toEqual({
      status: "invalid",
      path: configPath,
    });
    expect(readFileSync(configPath, "utf8")).toBe("{ this is not json");
    // Nothing was claimed, so a later release cannot delete a file it never wrote.
    await releaseMcpServers("s1");
    expect(existsSync(configPath)).toBe(true);
  });

  it("shares one file between two sessions and deletes it when the last one leaves", async () => {
    expect(await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS })).toMatchObject({
      status: "written",
    });
    // The second session finds the identical content: no rewrite, no repeated notice.
    expect(await injectMcpServers({ cwd, sessionId: "s2", servers: SERVERS })).toMatchObject({
      status: "unchanged",
    });

    await releaseMcpServers("s1");
    expect(Object.keys(readConfig().mcpServers).sort()).toEqual(["paseo-api", "paseo-fs"]);

    await releaseMcpServers("s2");
    expect(existsSync(configPath)).toBe(false);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces).toEqual({});
  });

  it("removes the .agents directory it created when the last session leaves", async () => {
    const agents = join(cwd, ".agents");
    expect(existsSync(agents)).toBe(false);

    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(agents)).toBe(true);

    await releaseMcpServers("s1");
    expect(existsSync(configPath)).toBe(false);
    // The file was the only thing in it, and the plugin made the directory.
    expect(existsSync(agents)).toBe(false);
  });

  it("keeps a .agents directory that was already there", async () => {
    const agents = join(cwd, ".agents");
    mkdirSync(agents, { recursive: true });

    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    await releaseMcpServers("s1");

    expect(existsSync(configPath)).toBe(false);
    // Empty, but not the plugin's to remove: the user had this directory before.
    expect(existsSync(agents)).toBe(true);
  });

  it("keeps a .agents directory the plugin created once anything else is in it", async () => {
    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    const notes = join(cwd, ".agents", "notes.md");
    writeFileSync(notes, "mine\n", "utf8");

    await releaseMcpServers("s1");

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(notes)).toBe(true);
  });

  it("removes the entries of a session that is no longer open", async () => {
    await injectMcpServers({ cwd, sessionId: "crashed", servers: SERVERS });
    await injectMcpServers({ cwd, sessionId: "live", servers: { api: SERVERS.api } });

    await sweepMcpLedger(new Set(["live"]));

    // Only what the live session still uses survives, and it keeps owning it.
    expect(Object.keys(readConfig().mcpServers)).toEqual(["paseo-api"]);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces[cwd].entries).toEqual({
      "paseo-api": ["live"],
    });
    await releaseMcpServers("live");
    expect(existsSync(configPath)).toBe(false);
  });
});

/**
 * The config file holds Paseo's bearer token, so git must never offer it for a commit. A clone's
 * own `info/exclude` is the one ignore file a plugin may write: it is not tracked, so nothing the
 * user shares changes, and it takes effect for `git add .` exactly like `.gitignore` does.
 */
describe("keeping the config out of the user's commits", () => {
  /** A real repository: the assertions below are git's own answers, not a re-implementation. */
  function initRepo(name: string): string {
    const repo = join(root, name);
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    return repo;
  }

  function git(repo: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  /**
   * The exclude file git reads, in the common git dir that linked worktrees share. git resolves
   * the paths it prints, so the expected path is the real one (`/var` and `/private/var` differ).
   */
  function excludeFile(repo: string): string {
    return join(realpathSync(repo), ".git", "info", "exclude");
  }

  function excludeLines(repo: string): string[] {
    const path = excludeFile(repo);
    return existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  }

  it("hides the config from git status in the repository around it", async () => {
    const repo = initRepo("repo");
    const work = join(repo, "workspace");
    mkdirSync(work, { recursive: true });

    await injectMcpServers({ cwd: work, sessionId: "s1", servers: SERVERS });

    // This file carries `Authorization: Bearer T`, and one `git add .` used to commit it: status
    // must not offer it at all.
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(excludeLines(repo)).toEqual(
      expect.arrayContaining([
        "# added by paseo antigravity-cli plugin: /workspace/.agents/mcp_config.json",
        "/workspace/.agents/mcp_config.json",
      ]),
    );
    // Only git's own local exclude file is written; nothing the repository tracks is touched.
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces[work].gitExclude).toEqual({
      file: excludeFile(repo),
      pattern: "/workspace/.agents/mcp_config.json",
    });
  });

  it("writes the pattern relative to the repository root for a nested workspace", async () => {
    const repo = initRepo("repo");
    const work = join(repo, "src", "deep");
    mkdirSync(work, { recursive: true });

    await injectMcpServers({ cwd: work, sessionId: "s1", servers: SERVERS });

    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(excludeLines(repo)).toContain("/src/deep/.agents/mcp_config.json");
  });

  it("excludes in the common git dir when the workspace is a linked worktree", async () => {
    const repo = initRepo("repo");
    writeFileSync(join(repo, "README.md"), "x\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
    const tree = join(root, "tree");
    git(repo, "worktree", "add", "-q", "-b", "linked", tree);

    await injectMcpServers({ cwd: tree, sessionId: "s1", servers: SERVERS });

    // `git status` in the worktree is the proof that the common dir's file is the one git reads.
    expect(git(tree, "status", "--porcelain")).toBe("");
    expect(excludeLines(repo)).toContain("/.agents/mcp_config.json");
  });

  it("leaves a workspace that is not a repository alone", async () => {
    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });

    // Sharing still works; there is simply no repository to exclude the file in.
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces[cwd].gitExclude).toBeUndefined();
  });

  it("adds its exclude lines once, however many sessions inject", async () => {
    const repo = initRepo("repo");
    const work = join(repo, "workspace");
    mkdirSync(work, { recursive: true });

    await injectMcpServers({ cwd: work, sessionId: "s1", servers: SERVERS });
    await injectMcpServers({ cwd: work, sessionId: "s2", servers: SERVERS });

    const pattern = "/workspace/.agents/mcp_config.json";
    // Exactly the marker and the pattern, once each, in that order: the second session found both.
    expect(excludeLines(repo).filter((line) => line.includes(pattern))).toEqual([
      `# added by paseo antigravity-cli plugin: ${pattern}`,
      pattern,
    ]);
  });

  it("appends after a last line that has no newline of its own", async () => {
    const repo = initRepo("repo");
    const work = join(repo, "workspace");
    mkdirSync(work, { recursive: true });
    const file = excludeFile(repo);
    // git reads this file happily; appending to it naively would glue the two lines into one.
    writeFileSync(file, "*.log", "utf8");

    await injectMcpServers({ cwd: work, sessionId: "s1", servers: SERVERS });

    expect(readFileSync(file, "utf8")).toBe(
      "*.log\n# added by paseo antigravity-cli plugin: /workspace/.agents/mcp_config.json\n/workspace/.agents/mcp_config.json\n",
    );
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("takes its own exclude lines back on release and leaves the rest", async () => {
    const repo = initRepo("repo");
    const work = join(repo, "workspace");
    mkdirSync(work, { recursive: true });
    const file = excludeFile(repo);
    const mine = "# the user's own notes\n*.log\n";
    writeFileSync(file, mine, "utf8");

    await injectMcpServers({ cwd: work, sessionId: "s1", servers: SERVERS });
    expect(readFileSync(file, "utf8")).not.toBe(mine);

    await releaseMcpServers("s1");

    expect(readFileSync(file, "utf8")).toBe(mine);
  });

  it("keeps an exclude line the user wrote themselves", async () => {
    const repo = initRepo("repo");
    const work = join(repo, "workspace");
    mkdirSync(work, { recursive: true });
    const file = excludeFile(repo);
    const theirs = "/workspace/.agents/mcp_config.json\n";
    writeFileSync(file, theirs, "utf8");

    await injectMcpServers({ cwd: work, sessionId: "s1", servers: SERVERS });

    // Already excluded by a line that is not the plugin's, so nothing is added and nothing claimed.
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(file, "utf8")).toBe(theirs);

    await releaseMcpServers("s1");
    expect(readFileSync(file, "utf8")).toBe(theirs);
  });
});
