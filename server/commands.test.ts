import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, discoverCommands, renderSkillPrompt } from "./commands";

const originalHome = process.env.HOME;

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-commands-home-"));
  workspace = mkdtempSync(join(tmpdir(), "antigravity-commands-work-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function skill(frontmatter: string, body = "Reply with exactly: ok\n"): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function writeSkill(root: string, dir: string, content: string): void {
  const path = join(workspace, root, "skills", dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), content, "utf8");
}

/** The roots the CLI reads outside a workspace, highest precedence first. */
const GLOBAL_ROOTS = [".gemini/antigravity-cli/skills", ".gemini/config/skills", ".gemini/skills"];

function writeGlobalSkill(root: string, dir: string, content: string): void {
  const path = join(home, root, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), content, "utf8");
}

/**
 * A skill outside the CLI's own roots, of the kind a `skills.json` entry points at, written at the
 * item directory `dir` and named after its last path segment.
 */
function writeItemSkill(dir: string): void {
  const name = basename(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skill(`name: ${name}\ndescription: ${name}`), "utf8");
}

/** The `skills.json` at `dir` — by default the workspace's own — with the given config in it. */
function writeSkillsConfig(config: unknown, dir = join(workspace, ".agents")): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skills.json"), JSON.stringify(config), "utf8");
}

/** An agent file of the shape the CLI reads, with `extra` appended to its frontmatter. */
function writeAgent(path: string, name: string, description: string, extra = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`, "utf8");
}

/** The CLI's own settings file, trusting the given workspace paths. */
function trustWorkspaces(...entries: readonly string[]): void {
  const dir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ trustedWorkspaces: entries }), "utf8");
}

async function agentNames(): Promise<string[]> {
  return (await discoverAgents(workspace)).map((agent) => agent.name);
}

async function names(): Promise<string[]> {
  return (await discoverCommands(workspace)).commands.map((command) => command.name);
}

/**
 * The CLI's own workflows, which `discoverCommands` publishes ahead of every skill. `/boost` and
 * `/browser` were probed 2026-09-24 (see Task 19 in tasks/todo.md) and are listed here so the
 * index-based assertions below cannot drift when one is added.
 */
const CLI_WORKFLOWS = [
  "plan",
  "goal",
  "grill-me",
  "teamwork-preview",
  "learn",
  "schedule",
  "boost",
  "browser",
] as const;

describe("discoverCommands", () => {
  it("offers the CLI's own workflows first", async () => {
    expect((await discoverCommands(workspace)).commands).toEqual(
      CLI_WORKFLOWS.map((name) => ({ name, description: expect.any(String) })),
    );
  });

  it("finds a skill in every customization root the CLI reads", async () => {
    // Probed 2026-09-23: a skill in each of the four expanded as `(skill)`.
    for (const [index, root] of [".agents", ".agent", "_agents", "_agent"].entries()) {
      writeSkill(root, `root-${index}`, skill(`name: root-${index}\ndescription: Root ${index}`));
    }

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.slice(CLI_WORKFLOWS.length)).toEqual([
      { name: "root-0", description: "Root 0" },
      { name: "root-1", description: "Root 1" },
      { name: "root-2", description: "Root 2" },
      { name: "root-3", description: "Root 3" },
    ]);
  });

  it("uses the skill's frontmatter name and reads a folded description", async () => {
    // The directory name is not the command: `/probe-dir-name` did not expand, `/probe-front-name`
    // did (probed 2026-09-23).
    writeSkill(
      ".agents",
      "probe-dir-name",
      skill("name: probe-front-name\ndescription: >-\n  A folded description\n  over two lines"),
    );

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "probe-front-name",
      description: "A folded description over two lines",
    });
  });

  it("skips a SKILL.md the CLI would not treat as a command", async () => {
    writeSkill(".agents", "no-frontmatter", "Just a body, with no frontmatter at all.\n");
    writeSkill(".agents", "no-name", skill("description: A skill without a name"));
    writeSkill(".agents", "bad-name", skill("name: two words\ndescription: Not a command name"));
    writeSkill(".agents", "not-a-skill", skill("name: not-a-skill"));
    rmSync(join(workspace, ".agents", "skills", "not-a-skill", "SKILL.md"));

    expect(await names()).toEqual([...CLI_WORKFLOWS]);
  });

  it("bounds a long description to one line", async () => {
    writeSkill(".agents", "wordy", skill(`name: wordy\ndescription: ${"word ".repeat(200)}`));

    const command = (await discoverCommands(workspace)).commands.at(-1);
    expect(command?.description.length).toBeLessThanOrEqual(241);
    expect(command?.description.endsWith("…")).toBe(true);
  });

  it("lists the skills of the plugins installed for the CLI", async () => {
    // Probed 2026-09-23: `/firebase:firebase-basics` expanded, named for the plugin directory and
    // the skill's own frontmatter name.
    const path = join(home, ".gemini", "config", "plugins", "firebase", "skills", "firebase_basics");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      skill("name: firebase-basics\ndescription: Firebase basics"),
      "utf8",
    );

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "firebase:firebase-basics",
      description: "Firebase basics",
    });
  });

  it("lists a plugin that keeps its one skill directly in skills/", async () => {
    // Probed 2026-09-23: `/android-cli-plugin:..:android-cli` expanded, while the same name without
    // the `..` did not, so the placeholder belongs in the published name.
    const path = join(home, ".gemini", "config", "plugins", "android-cli-plugin", "skills");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), skill("name: android-cli\ndescription: Android CLI"), "utf8");

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "android-cli-plugin:..:android-cli",
      description: "Android CLI",
    });
  });

  it("lists the skills the CLI ships with", async () => {
    // Probed 2026-09-23: `/migrate-workflows` expanded from the CLI's own unpacked skills.
    const path = join(home, ".gemini", "antigravity-cli", "builtin", "skills", "migrate-workflows");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      skill("name: migrate-workflows\ndescription: Migrate legacy workflows"),
      "utf8",
    );

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "migrate-workflows",
      description: "Migrate legacy workflows",
    });
  });

  it("lists the skills of the CLI's global roots", async () => {
    // Probed 2026-09-23 (CLI 1.2.9): a skill in each of the three expanded as `(skill)`, and the
    // picker shows them in the CLI's own precedence order.
    for (const [index, root] of GLOBAL_ROOTS.entries()) {
      const frontmatter = `name: global-${index}\ndescription: Global ${index}`;
      writeGlobalSkill(root, `global-${index}`, skill(frontmatter));
    }

    expect((await names()).slice(CLI_WORKFLOWS.length)).toEqual([
      "global-0",
      "global-1",
      "global-2",
    ]);
  });

  it("keeps the workspace copy of a name the global roots also have", async () => {
    // Probed 2026-09-23: with one name in the workspace and in every global root, the CLI expanded
    // the workspace copy — the picker must describe that same copy.
    const frontmatter = (description: string) => `name: release-notes\ndescription: ${description}`;
    writeSkill(".agents", "release-notes", skill(frontmatter("Workspace copy")));
    writeGlobalSkill(".gemini/config/skills", "release-notes", skill(frontmatter("Global copy")));
    writeGlobalSkill(".gemini/skills", "release-notes", skill(frontmatter("Legacy copy")));

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.filter((command) => command.name === "release-notes")).toEqual([
      { name: "release-notes", description: "Workspace copy" },
    ]);
  });

  it("keeps the copy from the highest global root when two of them share a name", async () => {
    for (const [index, root] of GLOBAL_ROOTS.entries()) {
      writeGlobalSkill(root, "triage", skill(`name: triage\ndescription: Root ${index}`));
    }

    const triage = (await discoverCommands(workspace)).commands.filter((command) => command.name === "triage");
    expect(triage).toEqual([{ name: "triage", description: "Root 0" }]);
  });

  it("offers every command once when a name is claimed twice", async () => {
    writeSkill(".agents", "dup", skill("name: plan\ndescription: A workspace plan"));

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.filter((command) => command.name === "plan")).toHaveLength(1);
    // The CLI's own workflow keeps the name; a workspace skill cannot shadow it.
    expect(commands[0]?.description).not.toBe("A workspace plan");
  });

  it("offers a shared-installer skill and marks it as one this plugin expands", async () => {
    // Probed 2026-09-23: the CLI reads neither `~/.agents/skills` nor `.agents/skills` under the
    // home directory, so the picker only offers this one because the plugin expands it itself.
    writeGlobalSkill(".agents/skills", "release-notes", skill("name: release-notes\ndescription: Draft notes"));

    const discovered = await discoverCommands(workspace);
    expect(discovered.commands.at(-1)).toEqual({
      name: "release-notes",
      description: "Draft notes",
    });
    expect(discovered.expanded.get("release-notes")).toEqual({
      name: "release-notes",
      description: "Draft notes",
      dir: join(home, ".agents", "skills", "release-notes"),
      path: join(home, ".agents", "skills", "release-notes", "SKILL.md"),
    });
  });

  it("leaves a shared skill to the command the CLI expands itself", async () => {
    // A name the CLI resolves on its own is the one the user gets, so the copy in the shared
    // directory is not offered and not expanded by the plugin.
    writeSkill(".agents", "release-notes", skill("name: release-notes\ndescription: Workspace copy"));
    writeGlobalSkill(".agents/skills", "release-notes", skill("name: release-notes\ndescription: Shared copy"));

    const discovered = await discoverCommands(workspace);
    expect(discovered.commands.filter((command) => command.name === "release-notes")).toEqual([
      { name: "release-notes", description: "Workspace copy" },
    ]);
    expect(discovered.expanded.has("release-notes")).toBe(false);
  });

  it("builds the turn text from the skill's body without its frontmatter", async () => {
    writeGlobalSkill(
      ".agents/skills",
      "release-notes",
      skill("name: release-notes\ndescription: Draft notes", "List the merged pull requests.\n"),
    );
    const expanded = (await discoverCommands(workspace)).expanded.get("release-notes");
    if (expanded === undefined) throw new Error("the shared skill was not discovered");

    expect(await renderSkillPrompt(expanded, "for v1.2")).toEqual({
      kind: "text",
      text:
        `[Skill: release-notes]\nList the merged pull requests.` +
        `\n\nSkill directory: ${expanded.dir} — resolve relative paths in these instructions against it.` +
        `\n\nUser request: for v1.2`,
    });
    // A command sent without arguments has no request to append.
    expect(await renderSkillPrompt(expanded, "")).toMatchObject({
      kind: "text",
      text: expect.not.stringContaining("User request:"),
    });

    rmSync(expanded.path);
    expect(await renderSkillPrompt(expanded, "for v1.2")).toMatchObject({ kind: "unreadable" });
  });

  it("skips disabled plugins from config.json and plugin.json", async () => {
    // Plugin disabled via config.json
    const disabledPath = join(home, ".gemini", "config", "plugins", "disabled-plugin", "skills", "disabled_skill");
    mkdirSync(disabledPath, { recursive: true });
    writeFileSync(join(disabledPath, "SKILL.md"), skill("name: disabled-skill\ndescription: Disabled"), "utf8");

    // Plugin disabled via plugin.json
    const pluginJsonPath = join(home, ".gemini", "config", "plugins", "self-disabled");
    mkdirSync(join(pluginJsonPath, "skills", "sub"), { recursive: true });
    writeFileSync(join(pluginJsonPath, "plugin.json"), JSON.stringify({ disabled: true }), "utf8");
    writeFileSync(join(pluginJsonPath, "skills", "sub", "SKILL.md"), skill("name: self-disabled-skill\ndescription: Self disabled"), "utf8");

    // Enabled plugin
    const enabledPath = join(home, ".gemini", "config", "plugins", "active-plugin", "skills", "active_skill");
    mkdirSync(enabledPath, { recursive: true });
    writeFileSync(join(enabledPath, "SKILL.md"), skill("name: active-skill\ndescription: Active"), "utf8");

    // Write config.json
    const configDir = join(home, ".gemini", "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ plugins: { "disabled-plugin": { enabled: false }, "active-plugin": { enabled: true } } }),
      "utf8",
    );

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.some((c) => c.name.includes("disabled-skill"))).toBe(false);
    expect(commands.some((c) => c.name.includes("self-disabled-skill"))).toBe(false);
    expect(commands.some((c) => c.name.includes("active-skill"))).toBe(true);
  });

  it("lets config.json override plugin.json, and ignores enabled: false in it", async () => {
    // Probed 2026-09-25 (`fixtures/13-agents.txt` §5) against the CLI's own doc: `disabled: true`
    // in `plugin.json` turns a plugin off, `enabled: false` there does nothing, and config.json
    // wins wherever it has an entry.
    const plugins = join(home, ".gemini", "config", "plugins");
    for (const [dir, pluginJson] of [
      ["reenabled-plugin", { disabled: true }],
      ["enabled-false-plugin", { enabled: false }],
    ] as const) {
      const path = join(plugins, dir, "skills", "sub");
      mkdirSync(path, { recursive: true });
      writeFileSync(join(plugins, dir, "plugin.json"), JSON.stringify(pluginJson), "utf8");
      writeFileSync(join(path, "SKILL.md"), skill(`name: ${dir}-skill\ndescription: ${dir}`), "utf8");
    }
    const configDir = join(home, ".gemini", "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ plugins: { "reenabled-plugin": { enabled: true } } }),
      "utf8",
    );

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.some((c) => c.name.includes("reenabled-plugin-skill"))).toBe(true);
    expect(commands.some((c) => c.name.includes("enabled-false-plugin-skill"))).toBe(true);
  });

  it("discovers skills from skills.json with 1-level deep scanning and include_only/exclude", async () => {
    const customDir = join(workspace, "custom-skills");
    mkdirSync(join(customDir, "skill-a"), { recursive: true });
    writeFileSync(join(customDir, "skill-a", "SKILL.md"), skill("name: custom-a\ndescription: Custom A"), "utf8");

    mkdirSync(join(customDir, "skill-b"), { recursive: true });
    writeFileSync(join(customDir, "skill-b", "SKILL.md"), skill("name: custom-b\ndescription: Custom B"), "utf8");

    mkdirSync(join(customDir, "nested", "deep-skill"), { recursive: true });
    writeFileSync(join(customDir, "nested", "deep-skill", "SKILL.md"), skill("name: deep-skill\ndescription: Deep"), "utf8");

    mkdirSync(join(workspace, ".agents"), { recursive: true });
    writeFileSync(
      join(workspace, ".agents", "skills.json"),
      JSON.stringify({
        entries: [
          { path: "custom-skills", exclude: ["skill-b"] },
          { path: "custom-skills", include_only: ["nested/deep-skill"] },
        ],
      }),
      "utf8",
    );

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.some((c) => c.name === "custom-a")).toBe(true);
    expect(commands.some((c) => c.name === "custom-b")).toBe(false); // excluded
    expect(commands.some((c) => c.name === "deep-skill")).toBe(true); // included via include_only
  });

  it("loads nothing, and does not fail, for a name no item has", async () => {
    writeItemSkill(join(workspace, "custom-skills", "skill-a"));
    writeSkillsConfig({ entries: [{ path: "custom-skills", include_only: ["["] }] });

    const discovered = await names();
    expect(discovered).not.toContain("skill-a");
    // Discovery still resolved: a name the CLI cannot use is not a broken workspace.
    expect(discovered).toContain("plan");
  });

  it("excludes the item the entry names, and nothing else", async () => {
    writeItemSkill(join(workspace, "custom-skills", "skill-b"));
    writeItemSkill(join(workspace, "custom-skills", "skill-bar"));
    writeSkillsConfig({ entries: [{ path: "custom-skills", exclude: ["skill-b"] }] });

    const discovered = await names();
    expect(discovered).not.toContain("skill-b");
    expect(discovered).toContain("skill-bar");
  });

  it("does not treat an exclude name as a pattern", async () => {
    // Probed 2026-09-25 with `agy --print /skills`: `exclude: ["skill-.*"]` excluded neither item,
    // while the same list holding `skill-b` excluded exactly that one.
    writeItemSkill(join(workspace, "custom-skills", "skill-b"));
    writeItemSkill(join(workspace, "custom-skills", "skill-bar"));
    writeSkillsConfig({ entries: [{ path: "custom-skills", exclude: ["skill-.*"] }] });

    const discovered = await names();
    expect(discovered).toContain("skill-b");
    expect(discovered).toContain("skill-bar");
  });

  it("names include_only items exactly, and never as patterns", async () => {
    for (const item of ["lint-a", "lint-b"]) writeItemSkill(join(workspace, "custom-skills", item));
    // Probed 2026-09-25 with `agy --print /skills`: the CLI loaded nothing for `lint-.*`.
    writeSkillsConfig({ entries: [{ path: "custom-skills", include_only: ["lint-.*"] }] });
    expect(await names()).not.toContain("lint-a");

    // A name an item does have loads it, and the entry's own exclude still wins.
    writeSkillsConfig({ entries: [{ path: "custom-skills", include_only: ["lint-a", "lint-b"], exclude: ["lint-b"] }] });
    const discovered = await names();
    expect(discovered).toContain("lint-a");
    expect(discovered).not.toContain("lint-b");
  });

  it("loads a nested item named by its relative path in include_only", async () => {
    writeItemSkill(join(workspace, "custom-skills", "top-level"));
    writeItemSkill(join(workspace, "custom-skills", "nested", "deep"));
    writeSkillsConfig({ entries: [{ path: "custom-skills", include_only: ["nested/deep"] }] });

    const discovered = await names();
    expect(discovered).toContain("deep");
    // The entry loads nothing else, because its `include_only` names no one-level item.
    expect(discovered).not.toContain("top-level");
  });

  it("matches a nested item by its whole path, and excludes it by path or directory name", async () => {
    writeItemSkill(join(workspace, "custom-skills", "nested", "deep"));
    // Probed 2026-09-25 with `agy --print /skills`: both forms dropped the nested item, while a bare
    // `include_only: ["deep"]` loaded it neither — a nested item is only ever named by its path.
    for (const entry of [
      { path: "custom-skills", include_only: ["nested/deep"], exclude: ["deep"] },
      { path: "custom-skills", include_only: ["nested/deep"], exclude: ["nested/deep"] },
      { path: "custom-skills", include_only: ["deep"] },
    ]) {
      writeSkillsConfig({ entries: [entry] });
      expect(await names()).not.toContain("deep");
    }
  });

  it("applies an inherits entry's filters to everything the inherited file names", async () => {
    writeItemSkill(join(workspace, "shared", "keep-me"));
    writeItemSkill(join(workspace, "shared", "drop-me"));
    // The inherited file reaches its items through an inherit of its own, which the filter covers.
    writeSkillsConfig({ entries: [{ path: "shared" }] }, join(workspace, "deeper"));
    // An inherited file's own relative paths resolve against the repository root too, so this one
    // is `deeper/skills.json` and not a path inside `shared-configs`.
    writeSkillsConfig({ inherits: [{ path: "deeper/skills.json" }] }, join(workspace, "shared-configs"));
    writeSkillsConfig({
      inherits: [{ path: "shared-configs/skills.json", exclude: ["drop-me"] }],
    });

    const discovered = await names();
    expect(discovered).toContain("keep-me");
    expect(discovered).not.toContain("drop-me");
  });

  it("resolves a relative entry path against the repository root, not the cwd", async () => {
    const repo = join(workspace, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeItemSkill(join(repo, "tools", "skills", "root-skill"));
    writeItemSkill(join(repo, "sub", "tools", "skills", "local-skill"));
    writeSkillsConfig({ entries: [{ path: "tools/skills" }] }, join(repo, "sub", ".agents"));

    const discovered = (await discoverCommands(join(repo, "sub"))).commands.map((command) => command.name);
    expect(discovered).toContain("root-skill");
    expect(discovered).not.toContain("local-skill");
  });

  it("discovers skills named by the global config file", async () => {
    writeItemSkill(join(workspace, "repo-skills", "repo-skill"));
    writeItemSkill(join(home, "installed", "home-skill"));
    // The global file is read in the precedence slot of `~/.gemini/config/skills`, so its copy of a
    // name `~/.gemini/skills` also has is the one the CLI expands.
    const legacy = join(home, ".gemini", "skills", "home-skill");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), skill("name: home-skill\ndescription: Legacy copy"), "utf8");
    writeSkillsConfig(
      { entries: [{ path: join(home, "installed") }, { path: "repo-skills" }] },
      join(home, ".gemini", "config"),
    );

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands).toContainEqual({ name: "repo-skill", description: "repo-skill" });
    expect(commands.filter((command) => command.name === "home-skill")).toEqual([
      { name: "home-skill", description: "home-skill" },
    ]);
  });

  it("lists an agent from either shape, in a trusted workspace", async () => {
    writeAgent(join(workspace, ".agents", "agents", "reviewer.md"), "code-reviewer", "Reviews code thoroughly");
    writeAgent(join(home, ".gemini", "antigravity-cli", "agents", "helper.md"), "global-helper", "General helper");
    trustWorkspaces(workspace);

    expect(await discoverAgents(workspace)).toEqual([
      { name: "code-reviewer", description: "Reviews code thoroughly" },
      { name: "global-helper", description: "General helper" },
    ]);
  });

  it("reads the flat and directory shapes, and takes the frontmatter name", async () => {
    const root = join(workspace, ".agents", "agents");
    writeAgent(join(root, "flat-one.md"), "flat-one", "Flat layout probe");
    writeAgent(join(root, "dir-two", "agent.md"), "dir-two", "Dir layout probe");
    // The directory name differs: the frontmatter `name` is what `--agent` takes.
    writeAgent(join(root, "mismatch-dir", "agent.md"), "renamed-agent", "Renamed probe");
    trustWorkspaces(workspace);

    expect(await agentNames()).toEqual(["dir-two", "flat-one", "renamed-agent"]);
  });

  it("keeps a hidden agent and drops a subagent-only one", async () => {
    const root = join(workspace, ".agents", "agents");
    writeAgent(join(root, "hidden-one.md"), "hidden-one", "Hidden probe", "hidden: true\n");
    writeAgent(join(root, "sub-only.md"), "sub-only", "Subagent probe", "mainAgent: false\n");
    trustWorkspaces(workspace);

    // Probed 2026-09-25: `agy agents` lists `hidden: true` and not `mainAgent: false`, and
    // `--agent hidden-one` runs while `--agent sub-only` answers as the default agent.
    expect(await agentNames()).toEqual(["hidden-one"]);
  });

  it("skips a file with no frontmatter, and the subagents directory", async () => {
    const root = join(workspace, ".agents", "agents");
    mkdirSync(join(root, "no-frontmatter"), { recursive: true });
    writeFileSync(join(root, "no-frontmatter", "agent.md"), "# No frontmatter\n", "utf8");
    writeAgent(join(root, "no-description.md"), "no-description", "");
    // Not an agent root: probed 2026-09-25, `agy agents` does not read it.
    writeAgent(join(workspace, ".agents", "subagents", "dir-five", "agent.md"), "dir-five", "Subagents probe");
    trustWorkspaces(workspace);

    expect(await agentNames()).toEqual([]);
  });

  it("lists the global agents only, until the workspace is trusted", async () => {
    writeAgent(join(workspace, ".agents", "agents", "flat-one.md"), "flat-one", "Workspace probe");
    writeAgent(join(home, ".gemini", "config", "agents", "global-dir", "agent.md"), "global-dir", "Global dir");
    writeAgent(join(home, ".gemini", "antigravity-cli", "agents", "global-flat.md"), "global-flat", "Global flat");

    // Probed 2026-09-25: an untrusted workspace lists nothing of its own, and `--agent` for one of
    // its agents is accepted and silently runs the default agent.
    expect(await agentNames()).toEqual(["global-dir", "global-flat"]);

    trustWorkspaces(workspace);
    expect(await agentNames()).toEqual(["flat-one", "global-dir", "global-flat"]);
  });

  it("trusts a workspace under a listed directory, but not a sibling with its prefix", async () => {
    writeAgent(join(workspace, ".agents", "agents", "flat-one.md"), "flat-one", "Workspace probe");

    // The settings file on this machine lists a directory holding many checkouts, so an entry has
    // to cover what is below it; `workspaceX` is a different directory that merely shares a prefix.
    trustWorkspaces(dirname(workspace));
    expect(await agentNames()).toEqual(["flat-one"]);

    trustWorkspaces(`${workspace}-sibling`);
    expect(await agentNames()).toEqual([]);
  });
});
