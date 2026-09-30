import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readSettingsFile } from "./agysettings";

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
    // Listed for the picker, but never sent to the CLI: agy's own `/plan` approves its own plan
    // review headless, so the provider runs it as its own plan-mode turn instead.
    name: "plan",
    description: "Plan the task and offer the plan for approval before making any changes.",
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
    const configs = await collectJsonConfig(join(cwd, root, "skills.json"), repoRoot, readConfigs, SKILL_CONFIG);
    for (const { value } of configs) remember(commands, value);
  }
  // A global skill is addressed by its own name and outranks the CLI's own skills, which is why
  // these are read before the plugins and the built-in set. The global `skills.json` scores in the
  // precedence slot of the root it sits beside, so it is read between those two roots.
  for (const root of GLOBAL_ROOTS) {
    await collectSkills(join(homedir(), root), commands);
    if (root === GLOBAL_CONFIG_ROOT) {
      const configs = await collectJsonConfig(join(homedir(), GLOBAL_CONFIG_FILE), repoRoot, readConfigs, SKILL_CONFIG);
      for (const { value } of configs) remember(commands, value);
    }
  }
  // Verified 2026-09-23: `/firebase:firebase-basics` expanded, so a plugin's skills are addressed
  // by the plugin's directory name and the skill's own name. A plugin that keeps its one skill
  // directly in `skills/` is addressed with a `..` placeholder instead of a directory:
  // `/android-cli-plugin:..:android-cli` expanded, while `/android-cli-plugin:android-cli` did not.
  // A frontmatter name that already starts with `<plugin>:` has it stripped first, in both shapes
  // (fixtures/21-plugin-skill-prefix.txt, 1.2.14).
  const configPlugins = await readConfigPlugins();
  const plugins = join(homedir(), ".gemini", "config", "plugins");
  for (const plugin of await subdirectories(plugins)) {
    if (await isPluginDisabled(plugin, configPlugins)) continue;
    const prefix = `${basename(plugin)}:`;
    const root = join(plugin, "skills");
    const flat = await readSkill(join(root, "SKILL.md"), prefix);
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
    const skill = await readSkill(join(dir, "SKILL.md"), prefix);
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
 *
 * `pluginPrefix` is `<plugin dir>:` for a plugin's skill: agy drops it from the front of the
 * frontmatter name before naming the command, so the name returned here is without it.
 */
async function readSkill(path: string, pluginPrefix = ""): Promise<AgyCommand | null> {
  let head: string;
  try {
    head = (await readFile(path)).subarray(0, SKILL_HEAD_BYTES).toString("utf8");
  } catch {
    return null;
  }
  const match = FRONTMATTER.exec(head);
  if (!match) return null;
  const block = match[1] ?? "";
  const declared = field(block, "name");
  // An empty prefix strips nothing, so a skill outside a plugin keeps its name as written.
  const name = declared?.startsWith(pluginPrefix) ? declared.slice(pluginPrefix.length) : declared;
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

/** One `inherits` or `entries` item of a customization file (`skills.json`, `agents.json`). */
interface ConfigEntry {
  /** The source the entry names: absolute, `~/`-relative (skills only), or relative to the repository root. */
  path?: string;
  /** Item names to keep; one carrying a `/` is a nested item's own relative path. */
  include_only?: readonly string[];
  /** Item names to skip, as a nested item's relative path or as its own item name. */
  exclude?: readonly string[];
}

interface ConfigFile {
  inherits?: readonly ConfigEntry[];
  entries?: readonly ConfigEntry[];
}

/**
 * An item a customization file names, with the item name the file's filters match it under: the
 * one-level item name, or the nested path the file wrote out in full.
 */
interface ConfiguredItem<T> {
  readonly item: string;
  readonly value: T;
}

/**
 * What differs between the customization files agy reads in the same `inherits`/`entries` shape.
 * The shape, the one-level scan, the exact-name filters and the repository-root resolution are
 * shared; how an item looks on disk, how a filter names it, and whether `~/` expands are not.
 */
interface ConfigKind<T> {
  /** The items directly inside an entry's directory, each under its one-level item name. */
  scan(dir: string): Promise<ConfiguredItem<T>[]>;
  /** A nested item, from its path under the entry's directory as `include_only` names it. */
  readNested(path: string): Promise<T | null>;
  /** An entry whose `path` names one item file rather than a directory; null when the kind has none. */
  readFile: ((path: string) => Promise<T | null>) | null;
  /** The item name a filter string refers to. */
  filterName(name: string): string;
  /** Whether a `~/…` path is expanded to the home directory. */
  expandHome: boolean;
}

/**
 * `skills.json`: an item is a directory holding `SKILL.md`. `~/` expands as the CLI's docs state —
 * unprobed for skills; `agents.json` was probed not to (fixtures/23), so this may be too generous.
 */
const SKILL_CONFIG: ConfigKind<AgyCommand> = {
  async scan(dir) {
    const found: ConfiguredItem<AgyCommand>[] = [];
    for (const sub of await subdirectories(dir)) {
      const skill = await readSkill(join(sub, "SKILL.md"));
      if (skill !== null) found.push({ item: basename(sub), value: skill });
    }
    return found;
  },
  readNested: (path) => readSkill(join(path, "SKILL.md")),
  readFile: null,
  filterName: (name) => name,
  expandHome: true,
};

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

function resolveConfigPath(repoRoot: string, targetPath: string, expandHome: boolean): string {
  if (targetPath.startsWith("/")) return targetPath;
  if (expandHome && targetPath.startsWith("~/")) return join(homedir(), targetPath.slice(2));
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
function applyFilters<T>(
  items: readonly ConfiguredItem<T>[],
  entry: ConfigEntry,
  kind: ConfigKind<T>,
): readonly ConfiguredItem<T>[] {
  const names = stringNames(entry.include_only).map(kind.filterName);
  const exclude = stringNames(entry.exclude).map(kind.filterName);
  return items.filter(
    (item) =>
      !exclude.some((name) => name === item.item || name === basename(item.item)) &&
      (names.length === 0 || names.includes(item.item)),
  );
}

/** The string entries of a config list; a name of any other type is not one the CLI can use. */
function stringNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

/**
 * The items one customization file names, in the order the file names them. An `inherits` entry is
 * read first and its own filters cover everything the inherited file produced, that file's
 * `inherits` included; the visited set is what keeps a cycle from reading a file twice.
 */
async function collectJsonConfig<T>(
  configPath: string,
  repoRoot: string,
  visited: Set<string>,
  kind: ConfigKind<T>,
): Promise<readonly ConfiguredItem<T>[]> {
  if (visited.has(configPath)) return [];
  visited.add(configPath);

  let parsed: ConfigFile;
  try {
    const raw = await readFile(configPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const items: ConfiguredItem<T>[] = [];
  const inherits = Array.isArray(parsed?.inherits) ? parsed.inherits : [];
  for (const inherit of inherits) {
    if (typeof inherit?.path !== "string") continue;
    const inheritedPath = resolveConfigPath(repoRoot, inherit.path, kind.expandHome);
    const inherited = await collectJsonConfig(inheritedPath, repoRoot, visited, kind);
    items.push(...applyFilters(inherited, inherit, kind));
  }

  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  for (const entry of entries) {
    if (typeof entry?.path !== "string") continue;
    items.push(...(await collectEntry(resolveConfigPath(repoRoot, entry.path, kind.expandHome), entry, kind)));
  }
  return items;
}

/**
 * The items one `entries` entry names. 1.2.10 loads the items directly inside its `path` and no
 * deeper, so an item further down is reached only by naming its whole relative path in
 * `include_only` — which is why the nested names are read here and the rest are scanned. An
 * `agents.json` entry may also name a single agent file (fixtures/23).
 */
async function collectEntry<T>(
  entryPath: string,
  entry: ConfigEntry,
  kind: ConfigKind<T>,
): Promise<readonly ConfiguredItem<T>[]> {
  const single = kind.readFile === null ? null : await kind.readFile(entryPath);
  if (single !== null) {
    return applyFilters([{ item: kind.filterName(basename(entryPath)), value: single }], entry, kind);
  }
  const found: ConfiguredItem<T>[] = [];
  for (const name of stringNames(entry.include_only)) {
    if (!name.includes("/")) continue;
    const item = kind.filterName(name);
    const value = await kind.readNested(join(entryPath, item));
    if (value !== null) found.push({ item, value });
  }
  found.push(...(await kind.scan(entryPath)));
  return applyFilters(found, entry, kind);
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

/** The global `agents.json`, read whether or not the workspace is trusted (fixtures/23). */
const GLOBAL_AGENT_CONFIG_FILE = ".gemini/config/agents.json";

/**
 * `agents.json` (probed on 1.2.14, fixtures/23): an item is `<name>.md` or `<name>/agent.md`, a
 * filter names it with or without its `.md`, an entry may name one agent file, and `~/` is not
 * expanded — such a path lists nothing.
 */
const AGENT_CONFIG: ConfigKind<DiscoveredAgent> = {
  scan: scanAgents,
  async readNested(path) {
    return (await readAgent(`${path}.md`)) ?? readAgent(join(path, "agent.md"));
  },
  readFile: readAgent,
  filterName: (name) => (name.endsWith(".md") ? name.slice(0, -".md".length) : name),
  expandHome: false,
};

/**
 * The custom agents the composer offers, in the order `agy agents` lists them. `geminiRoot` is the
 * root whose `settings.json` decides whether the workspace is trusted: the session's account one,
 * because `agy` launches under that account's `HOME`. The global agent roots stay on the real home,
 * which every account shares. Probed 2026-09-25 on 1.2.11 (`fixtures/13-agents.txt`): the
 * workspace's agents come from the same four launch-directory roots the CLI reads skills from —
 * `.agents`, `.agent` and `_agents` were verified for agents, and `_agent` is read on the strength
 * of the skill probe — and are hidden until that workspace is trusted, while the global roots are
 * always read. An agent is `<name>.md` or `<name>/agent.md`, with the frontmatter `name` deciding
 * what `--agent` is called with. Each root's `agents.json`, and the global one, name more agents in
 * the `skills.json` shape (1.2.14, fixtures/23); the workspace files are gated by trust too.
 */
export async function discoverAgents(
  cwd: string,
  geminiRoot: string,
): Promise<readonly DiscoveredAgent[]> {
  const agents = new Map<string, DiscoveredAgent>();
  const keep = (found: readonly ConfiguredItem<DiscoveredAgent>[]) => {
    for (const { value } of found) if (!agents.has(value.name)) agents.set(value.name, value);
  };
  // Relative paths in an `agents.json` resolve from the repository root, as in a `skills.json`.
  const repoRoot = await repositoryRoot(cwd);
  const readConfigs = new Set<string>();

  if (isWorkspaceTrusted(geminiRoot, cwd)) {
    for (const root of WORKSPACE_ROOTS) {
      keep(await scanAgents(join(cwd, root, "agents")));
      keep(await collectJsonConfig(join(cwd, root, "agents.json"), repoRoot, readConfigs, AGENT_CONFIG));
    }
  }

  for (const root of GLOBAL_AGENT_ROOTS) {
    keep(await scanAgents(join(homedir(), root)));
  }
  keep(await collectJsonConfig(join(homedir(), GLOBAL_AGENT_CONFIG_FILE), repoRoot, readConfigs, AGENT_CONFIG));

  return [...agents.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether the CLI reads the workspace's own agents: with the workspace untrusted, `agy agents`
 * printed nothing and `--agent <workspace agent>` answered as the default agent (probed
 * 2026-09-25). On 1.2.14 only an entry naming the workspace itself trusts it: a parent directory,
 * the home directory included, does not (probed 2026-09-30, fixtures/23). Paths are compared as
 * written, so another spelling of the same directory, through a symlink, is not trusted.
 */
function isWorkspaceTrusted(geminiRoot: string, cwd: string): boolean {
  const trusted = readSettingsFile(geminiRoot)?.trustedWorkspaces;
  if (!Array.isArray(trusted)) return false;
  const workspace = resolve(cwd);
  return trusted.some(
    (entry) =>
      typeof entry === "string" && entry.length > 0 && resolve(entry) === workspace,
  );
}

/**
 * The agents directly inside one directory, in the two shapes the CLI reads: `<name>.md` and
 * `<name>/agent.md`, each under its item name without the `.md`. Only `mainAgent: false` is
 * filtered, because the CLI lists those neither way; `hidden: true` agents are listed and
 * launchable. `.agents/subagents/` is not an agent root, and is never read.
 */
async function scanAgents(root: string): Promise<ConfiguredItem<DiscoveredAgent>[]> {
  const found: ConfiguredItem<DiscoveredAgent>[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const agent = entry.isDirectory()
        ? await readAgent(join(root, entry.name, "agent.md"))
        : entry.isFile() && entry.name.endsWith(".md")
          ? await readAgent(join(root, entry.name))
          : null;
      if (agent !== null) found.push({ item: AGENT_CONFIG.filterName(entry.name), value: agent });
    }
  } catch {
    // missing or unreadable directory
  }
  return found;
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
