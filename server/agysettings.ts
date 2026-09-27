import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The CLI's `settings.json`, parsed. The caller names the `.gemini` root it belongs to: the real
 * home for Default, an account's shadow home otherwise (`accountGeminiRoot`). A missing, unreadable
 * or malformed file is not an error: `null` means the caller has no settings to read, and
 * Antigravity's own defaults apply.
 */
export function readSettingsFile(geminiRoot: string): Record<string, unknown> | null {
  const path = join(geminiRoot, "antigravity-cli", "settings.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The Antigravity setting that decides how tool calls are approved (`always-proceed`,
 * `request-review`, `agent-decides`, `turbo` in agy 1.2.9). Read on each config build so the
 * composer can name the value a launch would actually use; only this preference is read, never
 * any credential. An absent value is not an error: the value is simply unknown and Antigravity's
 * own default applies.
 */
export function readToolPermission(geminiRoot: string): string | null {
  const value = readSettingsFile(geminiRoot)?.toolPermission;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
