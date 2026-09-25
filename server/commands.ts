import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The slash commands the composer offers. Paseo sends one as `/<name> <arguments>`, which the CLI
 * expands only when the process was launched without `--disable-slash-commands` — see the launch
 * profile in `provider.ts`, which relaunches for exactly those turns.
 */
export interface AgyCommand {
  readonly name: string;
  readonly description: string;
}

/**
 * The CLI's own workflows. Every one of them was verified to expand in `stream-json` mode with
 * `--log-file` (`Print mode: expanded slash command "<name>" (system)`) on Antigravity CLI 1.2.9,
 * 2026-09-23; the table and the raw commands are recorded under Task 19 in tasks/todo.md.
 *
 * Commands the CLI answers itself (`/skills`, `/usage`, `/model`, `/btw`, `/tasks`, …) are
 * deliberately absent: in print mode they fail the whole turn with `ERROR` and exit 2 instead of
 * being ignored, so sending one would kill the turn it was meant to start.
 *
 * Antigravity also ships built-ins it only enables for some accounts — `/compact`, `/review` and
 * `/owl` are gated behind server-side flags (`enable-compact-slash-command`,
 * `enable-owl-slash-command`, `enable-review`, and the `boost_command_disabled` /
 * `teamwork_preview_command_disabled` admin controls). A disabled one never expands: agy treats
 * the text as an ordinary message. Nothing can be probed into existence, so only the
 * unconditional ones are listed here; see the Task 19 table for every name that was tried.
 */
const SYSTEM_COMMANDS: readonly AgyCommand[] = [
  {
    name: "plan",
    description: "Plan the task before making changes (Antigravity's plan mode).",
  },
  {
    name: "goal",
    description: "Run the task as a long-running goal and keep working until it is complete.",
  },
  {
    name: "grill-me",
    description: "Interview you about the task, one question at a time, before starting work.",
  },
  {
    name: "teamwork-preview",
    description: "Approach the task with a team of autonomous agents.",
  },
  {
    name: "learn",
    description: "Record a behaviour for this workspace, in its GEMINI.md.",
  },
  {
    name: "schedule",
    description: "Create a recurring, scheduled run of a task.",
  },
  {
    name: "boost",
    description:
      "Approach the task with deep thinking, strategic planning, multiple perspectives, and rigorous verification.",
  },
  {
    name: "browser",
    description:
      "Browse the web, search, and work with web applications, through Antigravity's browser agent.",
  },
];

/**
 * The customization roots the CLI reads a workspace's skills from. A probe skill placed in each of
 * the four expanded as `(skill)` on 2026-09-23, which is the evidence for reading all four rather
 * than the documented `.agents` alone.
 */
const WORKSPACE_ROOTS = [".agents", ".agent", "_agents", "_agent"] as const;

/**
 * The skill roots the CLI reads outside a workspace, in the CLI's own precedence order. Probed
 * 2026-09-23 on CLI 1.2.9: a skill in each of the three expanded as `(skill)` in `stream-json`
 * mode, and when one name was installed in all of them the CLI listed — and ran — the highest of
 * the three, after the workspace copy.
 */
const GLOBAL_ROOTS = [
  ".gemini/antigravity-cli/skills",
  ".gemini/config/skills",
  ".gemini/skills",
] as const;

/**
 * The global `skills.json` the CLI reads, from the config directory beside the
 * `~/.gemini/config/skills` root whose precedence slot it takes. Its relative paths follow the same
 * rule as every other file's; that is unprobed — overriding `HOME` makes agy demand a login — so it
 * is what the CLI's own docs state rather than something that was seen.
 */
const GLOBAL_CONFIG_ROOT = ".gemini/config/skills";
const GLOBAL_CONFIG_FILE = ".gemini/config/skills.json";

/**
 * Where the shared skills installer other agent CLIs use puts its skills. Antigravity never reads
 * this directory — probed 2026-09-23: neither a probe skill there nor an installed one expanded,
 * and `agy --print /skills` never listed one — so this plugin expands those skills itself, and
 * only for names no command the CLI does expand has claimed. The other agent CLIs are its owner;
 * this plugin only reads it.
 */
const SHARED_SKILL_ROOT = ".agents/skills";

/** A plugin-expanded skill's own directory is handed to the CLI, so a turn can read its assets. */
export const MAX_SKILL_BYTES = 64 * 1024;

/** A skill the plugin expands itself, because the CLI does not read the directory it lives in. */
export interface ExpandedSkill {
  readonly name: string;
  readonly description: string;
  /** The skill's own directory: the turn's extra `--add-dir` and its base for relative paths. */
  readonly dir: string;
  /** The `SKILL.md` the body comes from. */
  readonly path: string;
}

/**
 * Bounds for a read that the draft composer repeats on every model, mode, and tier change: a
 * bounded directory listing per root, the frontmatter head of each SKILL.md, and a cap on how many
 * commands the session publishes.
 */
const MAX_DIRS_PER_ROOT = 64;
const MAX_COMMANDS = 64;
const SKILL_HEAD_BYTES = 4 * 1024;
const DESCRIPTION_LIMIT = 240;

/** A skill the CLI would not accept as a command name is not one the composer should offer. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const FIELD = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
const QUOTED = /^"(.*)"$|^'(.*)'$/;
const BLOCK_SCALAR = /^[>|][-+0-9]*$/;

/**
 * The commands the composer can offer, and which of them this plugin expands itself. The list
 * holds the CLI's own workflows, then the skills installed for this workspace, for every
 * workspace, by its plugins, and the set the CLI ships with — then the shared installer's skills,
 * for the names none of the CLI's own claimed.
 */
export interface DiscoveredCommands {
  /** What the composer offers, in the order it offers them. */
  readonly commands: readonly AgyCommand[];
  /** The commands this plugin expands itself, keyed by the name it publishes them under. */
  readonly expanded: ReadonlyMap<string, ExpandedSkill>;
}

/**
 * Every command the composer can offer, with the ones the CLI does not expand marked as ours.
 */
export async function discoverCommands(cwd: string): Promise<DiscoveredCommands> {
  const commands = new Map<string, AgyCommand>();
  for (const command of SYSTEM_COMMANDS) commands.set(command.name, command);
  // A `skills.json` resolves its relative paths against the repository root, so one workspace reads
  // the same files whatever directory the CLI runs in. A file only needs reading once however many
  // entries inherit it, which is what the shared visited set tracks.
  const repoRoot = await repositoryRoot(cwd);
  const readConfigs = new Set<string>();
  for (const root of WORKSPACE_ROOTS) {
    await collectSkills(join(cwd, root, "skills"), commands);
    const configs = await collectJsonConfigSkills(join(cwd, root, "skills.json"), repoRoot, readConfigs);
    for (const { skill } of configs) remember(commands, skill);
  }
  // A global skill is addressed by its own name and outranks the CLI's own skills, which is why
  // these are read before the plugins and the built-in set. The global `skills.json` scores in the
  // precedence slot of the root it sits beside, so it is read between those two roots.
  for (const root of GLOBAL_ROOTS) {
    await collectSkills(join(homedir(), root), commands);
    if (root === GLOBAL_CONFIG_ROOT) {
      const configs = await collectJsonConfigSkills(join(homedir(), GLOBAL_CONFIG_FILE), repoRoot, readConfigs);
      for (const { skill } of configs) remember(commands, skill);
    }
  }
  // Verified 2026-09-23: `/firebase:firebase-basics` expanded, so a plugin's skills are addressed
  // by the plugin's directory name and the skill's own name. A plugin that keeps its one skill
  // directly in `skills/` is addressed with a `..` placeholder instead of a directory:
  // `/android-cli-plugin:..:android-cli` expanded, while `/android-cli-plugin:android-cli` did not.
  const configPlugins = await readConfigPlugins();
  const plugins = join(homedir(), ".gemini", "config", "plugins");
  for (const plugin of await subdirectories(plugins)) {
    if (await isPluginDisabled(plugin, configPlugins)) continue;
    const prefix = `${basename(plugin)}:`;
    const root = join(plugin, "skills");
    const flat = await readSkill(join(root, "SKILL.md"));
    if (flat !== null) {
      remember(commands, { name: `${prefix}..:${flat.name}`, description: flat.description });
    }
    await collectSkills(root, commands, prefix);
  }
  // Where the CLI unpacks the skills it ships with, one directory per skill.
  const builtin = join(homedir(), ".gemini", "antigravity-cli", "builtin", "skills");
  await collectSkills(builtin, commands);
  // Last, because a name the CLI expands itself is the one the user gets: a skill here whose name
  // is taken is left to the CLI's own copy rather than offered twice with different behaviour.
  const expanded = new Map<string, ExpandedSkill>();
  for (const dir of await subdirectories(join(homedir(), SHARED_SKILL_ROOT))) {
    const path = join(dir, "SKILL.md");
    const skill = await readSkill(path);
    if (skill === null || commands.has(skill.name)) continue;
    remember(commands, skill);
    if (commands.has(skill.name)) expanded.set(skill.name, { ...skill, dir, path });
  }
  return { commands: [...commands.values()], expanded };
}

/**
 * The turn text for a plugin-expanded skill: a skill is instructions for the model, and the CLI
 * never sees the `/name`, so the body itself is the prompt. The directory line is what lets the
 * instructions use their own relative paths, and the request is appended exactly as typed.
 */
export type SkillPrompt =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "unreadable"; readonly message: string };

export async function renderSkillPrompt(
  skill: ExpandedSkill,
  request: string,
): Promise<SkillPrompt> {
  let raw: Buffer;
  try {
    raw = await readFile(skill.path);
  } catch (error) {
    return { kind: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  if (raw.byteLength > MAX_SKILL_BYTES) return { kind: "too_large", bytes: raw.byteLength };
  const text = raw.toString("utf8");
  const frontmatter = FRONTMATTER.exec(text);
  const body = (frontmatter ? text.slice(frontmatter[0].length) : text).trim();
  return {
    kind: "text",
    text:
      `[Skill: ${skill.name}]\n${body}` +
      `\n\nSkill directory: ${skill.dir} — resolve relative paths in these instructions against it.` +
      (request.length > 0 ? `\n\nUser request: ${request}` : ""),
  };
}

/** One `SKILL.md` per subdirectory is the shape the CLI lists as a skill command. */
async function collectSkills(
  root: string,
  commands: Map<string, AgyCommand>,
  prefix = "",
): Promise<void> {
  for (const dir of await subdirectories(root)) {
    const skill = await readSkill(join(dir, "SKILL.md"));
    if (skill === null) continue;
    remember(commands, { name: `${prefix}${skill.name}`, description: skill.description });
  }
}

/** The CLI resolves a slash name to one command, and the composer's list stays bounded. */
function remember(commands: Map<string, AgyCommand>, command: AgyCommand): void {
  if (commands.size >= MAX_COMMANDS || commands.has(command.name)) return;
  commands.set(command.name, command);
}

/** A missing or unreadable root is simply a root with no skills in it. */
async function subdirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort()
      .slice(0, MAX_DIRS_PER_ROOT);
  } catch {
    return [];
  }
}

/**
 * A skill file is otherwise arbitrary markdown, so only its head is read and only the two fields
 * the composer needs are taken from the frontmatter. A file whose frontmatter names no usable
 * command is skipped: the CLI does not expand one either (probed 2026-09-23 with a
 * frontmatter-less SKILL.md and with a directory whose name differs from its own `name`).
 */
async function readSkill(path: string): Promise<AgyCommand | null> {
  let head: string;
  try {
    head = (await readFile(path)).subarray(0, SKILL_HEAD_BYTES).toString("utf8");
  } catch {
    return null;
  }
  const match = FRONTMATTER.exec(head);
  if (!match) return null;
  const block = match[1] ?? "";
  const name = field(block, "name");
  if (name === null || !COMMAND_NAME.test(name)) return null;
  return { name, description: describeSkill(field(block, "description") ?? "") };
}

/** A frontmatter scalar, including the folded and literal blocks the CLI's own skills use. */
function field(block: string, key: string): string | null {
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = FIELD.exec(lines[index] ?? "");
    if (!match || match[1] !== key) continue;
    const inline = (match[2] ?? "").trim();
    if (inline.length > 0 && !BLOCK_SCALAR.test(inline)) {
      const quoted = QUOTED.exec(inline);
      return quoted ? (quoted[1] ?? quoted[2] ?? "") : inline;
    }
    const parts: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim().length === 0) continue;
      if (!/^[ \t]/.test(line)) break;
      parts.push(line.trim());
    }
    return parts.join(" ");
  }
  return null;
}

/**
 * The description Paseo shows beside the command, on one bounded line: the draft composer reads
 * the whole list on every model, mode, and tier change, and the CLI's own skills carry paragraphs.
 */
function describeSkill(description: string): string {
  const single = description.replace(/\s+/g, " ").trim();
  if (single.length <= DESCRIPTION_LIMIT) return single;
  const cut = single.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

async function readConfigPlugins(): Promise<Record<string, { enabled?: boolean }> | null> {
  const path = join(homedir(), ".gemini", "config", "config.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "plugins" in parsed) {
      const plugins = (parsed as { plugins: unknown }).plugins;
      if (typeof plugins === "object" && plugins !== null) {
        return plugins as Record<string, { enabled?: boolean }>;
      }
    }
  } catch {
    // missing or unreadable config
  }
  return null;
}

/**
 * Whether the CLI loads a plugin's customizations. Its own doc
 * (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/plugins.md`) states that
 * `config.json` wins wherever it has an entry — `{ "plugins": { "<dirname>": { "enabled": false } } }`
 * — and that a plugin ships switched off with `"disabled": true` in its `plugin.json`, so only that
 * flag is read from the file: probed 2026-09-25, `"enabled": false` there is ignored and the plugin
 * stays on (`fixtures/13-agents.txt` §5).
 */
async function isPluginDisabled(
  pluginDir: string,
  configPlugins: Record<string, { enabled?: boolean }> | null,
): Promise<boolean> {
  const dirName = basename(pluginDir);
  const fromConfig = configPlugins?.[dirName]?.enabled;
  if (typeof fromConfig === "boolean") return !fromConfig;
  try {
    const raw = await readFile(join(pluginDir, "plugin.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "disabled" in parsed) {
      return parsed.disabled === true;
    }
  } catch {
    return false;
  }
  return false;
}

interface SkillConfigEntry {
  /** The source the entry names: absolute, `~/`-relative, or relative to the repository root. */
  path?: string;
  /** Item names to keep; one carrying a `/` is a nested item's own relative path. */
  include_only?: readonly string[];
  /** Item names to skip, as a nested item's relative path or as its own directory name. */
  exclude?: readonly string[];
}

interface SkillConfigFile {
  inherits?: readonly SkillConfigEntry[];
  entries?: readonly SkillConfigEntry[];
}

/**
 * A skill a `skills.json` names, with the item name the file's filters match it under: the
 * one-level directory name, or the nested path the file wrote out in full.
 */
interface ConfiguredSkill {
  readonly item: string;
  readonly skill: AgyCommand;
}

/**
 * Where the CLI resolves a relative path in a `skills.json`: the repository root — the nearest
 * ancestor of the workspace holding a `.git`, stat'd so that a worktree's `.git` file counts — and
 * the workspace itself when there is no checkout above it. The path names the file the CLI is
 * running in, not the directory it was started from, which is also what its own docs state.
 */
async function repositoryRoot(cwd: string): Promise<string> {
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      // The filesystem root has no parent, and no repository above it either.
      if (parent === dir) return start;
      dir = parent;
    }
  }
}

function resolveConfigPath(repoRoot: string, targetPath: string): string {
  if (targetPath.startsWith("/")) return targetPath;
  if (targetPath.startsWith("~/")) return join(homedir(), targetPath.slice(2));
  return join(repoRoot, targetPath);
}

/**
 * A config entry's own `include_only` and `exclude` over the items of one source — the directory
 * its `path` names, or an inherited file. An entry with no `include_only` loads everything the
 * source has; one that sets it loads only the items it names, either a one-level item directory or
 * a nested item's whole relative path, matched in full. `exclude` names an item the same way, or by
 * its own directory name, and wins over `include_only`.
 *
 * The binary's docs call these lists of "patterns", but agy 1.2.11 matches exact names only. Probed
 * 2026-09-25 with `agy --print /skills`: `include_only: ["lint-.*"]` loaded nothing,
 * `exclude: ["skill-.*"]` excluded nothing, while `["deep"]` and `["nested/deep"]` both excluded the
 * nested item `nested/deep`.
 */
function applyFilters(items: readonly ConfiguredSkill[], entry: SkillConfigEntry): readonly ConfiguredSkill[] {
  const names = stringNames(entry.include_only);
  const exclude = stringNames(entry.exclude);
  return items.filter(
    (item) =>
      !exclude.some((name) => name === item.item || name === basename(item.item)) &&
      (names.length === 0 || names.includes(item.item)),
  );
}

/** The string entries of a `skills.json` list; a name of any other type is not one the CLI can use. */
function stringNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

/**
 * The skills one `skills.json` names, in the order the file names them. An `inherits` entry is read
 * first and its own filters cover everything the inherited file produced, that file's `inherits`
 * included; the visited set is what keeps a cycle from reading a file twice.
 */
async function collectJsonConfigSkills(
  configPath: string,
  repoRoot: string,
  visited: Set<string>,
): Promise<readonly ConfiguredSkill[]> {
  if (visited.has(configPath)) return [];
  visited.add(configPath);

  let parsed: SkillConfigFile;
  try {
    const raw = await readFile(configPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const skills: ConfiguredSkill[] = [];
  const inherits = Array.isArray(parsed?.inherits) ? parsed.inherits : [];
  for (const inherit of inherits) {
    if (typeof inherit?.path !== "string") continue;
    const inherited = await collectJsonConfigSkills(resolveConfigPath(repoRoot, inherit.path), repoRoot, visited);
    skills.push(...applyFilters(inherited, inherit));
  }

  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  for (const entry of entries) {
    if (typeof entry?.path !== "string") continue;
    skills.push(...(await collectEntry(resolveConfigPath(repoRoot, entry.path), entry)));
  }
  return skills;
}

/**
 * The skills one `entries` entry names. 1.2.10 loads the items directly inside its `path` and no
 * deeper, so an item further down is reached only by naming its whole relative path in
 * `include_only` — which is why the nested names are read here and the rest are scanned.
 */
async function collectEntry(entryDir: string, entry: SkillConfigEntry): Promise<readonly ConfiguredSkill[]> {
  const found: ConfiguredSkill[] = [];
  for (const item of stringNames(entry.include_only)) {
    if (!item.includes("/")) continue;
    const skill = await readSkill(join(entryDir, item, "SKILL.md"));
    if (skill !== null) found.push({ item, skill });
  }
  for (const dir of await subdirectories(entryDir)) {
    const skill = await readSkill(join(dir, "SKILL.md"));
    if (skill !== null) found.push({ item: basename(dir), skill });
  }
  return applyFilters(found, entry);
}

export interface DiscoveredAgent {
  readonly name: string;
  readonly description: string;
}

/**
 * The agent roots the CLI reads outside a workspace. Probed 2026-09-25 on 1.2.11: both list the
 * agents they hold, in either of the two shapes below (`fixtures/13-agents.txt`).
 */
const GLOBAL_AGENT_ROOTS = [".gemini/antigravity-cli/agents", ".gemini/config/agents"] as const;

/**
 * The CLI's settings file. A workspace's own agents, and `--agent` itself, do nothing until the
 * workspace is listed in its `trustedWorkspaces` — probed 2026-09-25: with the workspace untrusted,
 * `agy agents` printed nothing and `--agent <workspace agent>` answered as the default agent.
 */
const SETTINGS_FILE = ".gemini/antigravity-cli/settings.json";

/**
 * The custom agents the composer offers, in the order `agy agents` lists them. Probed 2026-09-25 on
 * 1.2.11 (`fixtures/13-agents.txt`): the workspace's agents come from the same four launch-directory
 * roots the CLI reads skills from — `.agents`, `.agent` and `_agents` were verified for agents, and
 * `_agent` is read on the strength of the skill probe — and are hidden until that workspace is
 * trusted, while the global roots are always read. An agent is `<name>.md` or `<name>/agent.md`,
 * with the frontmatter `name` deciding what `--agent` is called with.
 */
export async function discoverAgents(cwd: string): Promise<readonly DiscoveredAgent[]> {
  const agents = new Map<string, DiscoveredAgent>();

  if (await isWorkspaceTrusted(cwd)) {
    for (const root of WORKSPACE_ROOTS) {
      await collectAgents(join(cwd, root, "agents"), agents);
    }
  }

  for (const root of GLOBAL_AGENT_ROOTS) {
    await collectAgents(join(homedir(), root), agents);
  }

  return [...agents.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether the CLI reads the workspace's own agents. The store's `isUnder` and `matchedPrefixLen`
 * (jetski 1.2.11) compare the workspace against each `trustedWorkspaces` entry, so an entry covers
 * the paths beneath it — which is what makes the entry this machine's settings file holds, a
 * directory of many checkouts, useful at all. Read off the binary rather than probed, and paths are
 * compared as written: another spelling of the same directory, through a symlink, is not trusted.
 */
async function isWorkspaceTrusted(cwd: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(homedir(), SETTINGS_FILE), "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || !("trustedWorkspaces" in parsed)) return false;
  const trusted = parsed.trustedWorkspaces;
  if (!Array.isArray(trusted)) return false;
  const workspace = resolve(cwd);
  return trusted.some((entry) => isUnder(workspace, entry));
}

/** A trusted path covers the workspace itself and anything below it, but not a sibling prefix. */
function isUnder(workspace: string, entry: unknown): boolean {
  if (typeof entry !== "string" || entry.length === 0) return false;
  const base = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return workspace === base || workspace.startsWith(`${base}/`);
}

/**
 * The agents of one root, in the two shapes the CLI reads: `<name>.md` and `<name>/agent.md`. Only
 * `mainAgent: false` is filtered, because the CLI lists those neither way; `hidden: true` agents are
 * listed and launchable. `.agents/subagents/` is not an agent root, and is never read.
 */
async function collectAgents(root: string, agents: Map<string, DiscoveredAgent>): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = entry.isDirectory()
        ? join(root, entry.name, "agent.md")
        : entry.isFile() && entry.name.endsWith(".md")
          ? join(root, entry.name)
          : null;
      if (path === null) continue;
      const agent = await readAgent(path);
      if (agent !== null && !agents.has(agent.name)) agents.set(agent.name, agent);
    }
  } catch {
    // missing or unreadable directory
  }
}

/**
 * One agent file, or null for a file the CLI would not accept as an agent: the binary's own message
 * is `Markdown agent at %s is missing name or description in frontmatter`, and its `name` is what
 * `--agent` takes, so the file name is only a fallback the CLI does not use.
 */
async function readAgent(path: string): Promise<DiscoveredAgent | null> {
  let head: string;
  try {
    head = (await readFile(path)).subarray(0, SKILL_HEAD_BYTES).toString("utf8");
  } catch {
    return null;
  }
  const match = FRONTMATTER.exec(head);
  if (!match) return null;
  const block = match[1] ?? "";
  const name = field(block, "name");
  const description = field(block, "description");
  if (name === null || name.length === 0 || description === null || description.length === 0) return null;
  if ((field(block, "mainAgent") ?? "").toLowerCase() === "false") return null;
  return { name, description: describeSkill(description) };
}
