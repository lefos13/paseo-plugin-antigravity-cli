import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { resolveAgyBinary } from "./agy";

const execFileAsync = promisify(execFile);

/** The flash family, whose default tier is the model the CLI prefers out of the box. */
export const DEFAULT_MODEL_ID = "gemini-3.8-flash";
export const DEFAULT_MODE_ID = "default";

/** The tier a family defaults to when it has one, as `agy models` lists it first. */
const DEFAULT_TIER = "high";

/**
 * The reasoning tiers Antigravity encodes in the model id itself (`gemini-3.8-flash-high`). The
 * CLI rejects `--model X --effort Y` for those ids, so a tier is chosen as a thinking option and
 * resolved back into the slug the CLI accepts. `max` is here for a model that lists one — no model
 * on `agy models` 1.2.11 does, which the composer shows by offering the tiers the ids carry.
 */
const TIERS = ["max", "high", "medium", "low"] as const;
type Tier = (typeof TIERS)[number];

const TIER_ID = /^(?<base>.+)-(?<tier>max|high|medium|low)$/;
const TIER_LABEL = /\s*\((?:max|high|medium|low)\)$/i;

/** `default` is implicit: omitting --mode gives review-before-write behaviour. */
export const MODES: readonly ProviderMode[] = [
  { id: "default", label: "Default", description: "Review file writes before they run" },
  { id: "accept-edits", label: "Accept edits", description: "Accept file edits automatically" },
  { id: "plan", label: "Plan", description: "Plan without applying edits" },
];

/**
 * Captured verbatim from `agy models` on Antigravity CLI 1.2.9, used when live discovery is
 * unavailable. It is parsed and grouped exactly like a live list, so the composer shows the same
 * models either way.
 */
const FALLBACK_MODELS_OUTPUT = [
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
  "gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

export const FALLBACK_MODELS: readonly ProviderModel[] = groupModels(
  parseModels(FALLBACK_MODELS_OUTPUT),
);

const CACHE_TTL_MS = 10 * 60 * 1000;
const MODELS_TIMEOUT_MS = 20_000;

let cache: { key: string; at: number; models: readonly ProviderModel[] } | null = null;

/**
 * Identity of the CLI whose model list is cached. A different binary or a rebuilt one can report a
 * different list, so both the resolved path and its modification time belong in the key that Paseo
 * uses to decide whether to rediscover — and in the key this module caches under.
 */
export function catalogCacheKey(binary?: string): string {
  const resolved = resolveAgyBinary(binary);
  let mtime = "unknown";
  try {
    mtime = String(statSync(resolved).mtimeMs);
  } catch {
    // A PATH-resolved or deleted binary has no build identity; the path still keys the cache.
  }
  return `${resolved}|${mtime}|${process.env.PASEO_ANTIGRAVITY_BIN ?? ""}`;
}

/** Drops the discovered list so the next catalog request runs `agy models` again. */
export function invalidateCatalogCache(): void {
  cache = null;
}

/**
 * Synchronous view of the last discovered list, for `session.config` where an async lookup would
 * stall the provider. The catalog request path is what refreshes the cache.
 */
export function currentModels(): readonly ProviderModel[] {
  return cache?.models ?? FALLBACK_MODELS;
}

export async function buildCatalog(binary?: string): Promise<ProviderCatalog> {
  const models = await loadModels(binary);
  return {
    models,
    modes: MODES,
    // The tier axis belongs to each model (see `groupModels`), so there is no catalog-wide list.
    thinkingOptions: [],
    defaultModel: models.find((model) => model.id === DEFAULT_MODEL_ID)?.id ?? models[0]?.id,
    defaultMode: DEFAULT_MODE_ID,
  };
}

async function loadModels(binary?: string): Promise<readonly ProviderModel[]> {
  const key = catalogCacheKey(binary);
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;

  let models: readonly ProviderModel[] = [];
  try {
    const { stdout } = await execFileAsync(resolveAgyBinary(binary), ["models"], {
      timeout: MODELS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    models = groupModels(parseModels(stdout));
  } catch (error) {
    console.error(`[antigravity] falling back to bundled model list: ${describe(error)}`);
  }

  const resolved = models.length > 0 ? models : FALLBACK_MODELS;
  cache = { key, at: Date.now(), models: resolved };
  return resolved;
}

/**
 * `agy models` prints a header line and then tab-separated `slug<TAB>label` rows. Anything
 * that does not match that shape is skipped, so a progress banner cannot become a model.
 */
export function parseModels(stdout: string): readonly ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const [rawId, rawLabel] = line.split("\t");
    if (rawId === undefined || rawLabel === undefined) continue;
    const id = rawId.trim();
    const label = rawLabel.trim();
    if (id.length === 0 || label.length === 0) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label,
      // A tier slug is the default model too: `gemini-3.8-flash-high` is the default family's
      // default tier, and the list is grouped afterwards.
      isDefault: id === DEFAULT_MODEL_ID || splitTier(id)?.base === DEFAULT_MODEL_ID,
    });
  }

  return models;
}

function splitTier(id: string): { base: string; tier: Tier } | null {
  const match = TIER_ID.exec(id);
  if (!match?.groups) return null;
  return { base: match.groups.base, tier: match.groups.tier as Tier };
}

/**
 * Collapses `<family>-high|medium|low` rows into one model with a thinking option per tier, which
 * is the shape Paseo renders as a tier picker. A tier suffix with no sibling stays part of the id
 * (`gpt-oss-120b-medium`, `claude-opus-4-6-thinking`), and a persisted full slug still launches
 * unchanged through `resolveThinking`.
 */
export function groupModels(rows: readonly ProviderModel[]): readonly ProviderModel[] {
  const families = new Map<string, Set<Tier>>();
  for (const row of rows) {
    const split = splitTier(row.id);
    if (!split) continue;
    const tiers = families.get(split.base) ?? new Set<Tier>();
    tiers.add(split.tier);
    families.set(split.base, tiers);
  }

  const models: ProviderModel[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const split = splitTier(row.id);
    const tiers = split ? families.get(split.base) : undefined;
    if (!split || !tiers || tiers.size < 2) {
      models.push(row);
      continue;
    }
    if (emitted.has(split.base)) continue;
    emitted.add(split.base);

    const ordered = TIERS.filter((tier) => tiers.has(tier));
    const chosen = ordered.includes(DEFAULT_TIER) ? DEFAULT_TIER : ordered[0];
    models.push({
      id: split.base,
      label: row.label.replace(TIER_LABEL, ""),
      isDefault: split.base === DEFAULT_MODEL_ID,
      thinkingOptions: ordered.map((tier) => ({
        id: tier,
        label: `${tier[0].toUpperCase()}${tier.slice(1)}`,
        isDefault: tier === chosen,
      })),
      defaultThinkingOptionId: chosen,
    });
  }
  return models;
}

/**
 * The `(model, thinkingOption)` pair a session holds, resolved to what the CLI is launched with.
 * `model` may be a catalog family (`gemini-3.8-flash`) or a persisted full slug; a tier the model
 * does not have is ignored rather than turned into a slug the CLI would reject.
 */
export function resolveThinking(
  model: string | undefined,
  thinkingOption: string | undefined,
): { slug?: string; options: readonly ProviderThinkingOption[]; option?: string } {
  if (!model || model.length === 0) return { options: [] };
  const models = currentModels();
  const direct = models.find((entry) => entry.id === model);
  const family =
    direct && (direct.thinkingOptions?.length ?? 0) > 0
      ? direct
      : models.find(
          (entry) =>
            entry.id === splitTier(model)?.base && (entry.thinkingOptions?.length ?? 0) > 0,
        );
  const options = family?.thinkingOptions ?? [];
  if (!family || options.length === 0) return { slug: model, options: [] };

  const own = splitTier(model)?.tier;
  const chosen =
    (thinkingOption !== undefined && options.some((entry) => entry.id === thinkingOption)
      ? thinkingOption
      : undefined) ??
    (own !== undefined && options.some((entry) => entry.id === own) ? own : undefined) ??
    family.defaultThinkingOptionId ??
    options[0].id;
  return { slug: `${family.id}-${chosen}`, options, option: chosen };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
