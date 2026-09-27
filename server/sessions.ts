import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { accountGeminiRoot, listAccounts } from "./accounts";

const DEFAULT_LIMIT = 50;

/**
 * Only the columns Paseo needs, newest first. `parent_conversation_id` is filtered out rather than
 * selected: those rows are the runs Antigravity created for its own subagents, not conversations
 * a user can open.
 */
const SELECT_CONVERSATIONS = `select conversation_id, title, preview, last_modified_time, workspace_uris
from conversation_summaries
where parent_conversation_id = ''
order by last_modified_time desc`;

interface ConversationRow {
  conversation_id: string;
  title: string;
  preview: string;
  last_modified_time: string;
  workspace_uris: string;
}

export interface ConversationQuery {
  cwd?: string;
  query?: string;
  limit?: number;
}

/**
 * Reads Antigravity's own conversation index so an existing conversation can be opened in Paseo.
 * Every account keeps its own index under its own `.gemini`, so the conversations of Default and of
 * every stored account are merged, newest first, and each row carries the account that owns it:
 * opening it must resume the conversation under the account that created it. The databases are only
 * ever read (the CLI owns them), and every failure - missing file, unexpected schema, locked or
 * corrupt pages - yields no rows for that account plus a log line, never a thrown error. An account
 * that has not run yet has no index at all, which is normal and therefore not logged.
 */
export function listConversations(options: ConversationQuery): ProviderSessionSummary[] {
  const rows = readConversations();
  const wantedCwd = options.cwd === undefined ? undefined : stripTrailingSlash(options.cwd);
  const wantedText = options.query?.trim().toLowerCase();
  const requested = options.limit ?? DEFAULT_LIMIT;
  const limit = requested > 0 ? Math.floor(requested) : DEFAULT_LIMIT;

  const summaries: ProviderSessionSummary[] = [];
  for (const { row, accountId } of rows) {
    const workspace = firstWorkspacePath(row.workspace_uris);
    if (
      wantedCwd !== undefined &&
      (workspace === null || stripTrailingSlash(workspace) !== wantedCwd)
    ) {
      continue;
    }
    if (
      wantedText !== undefined &&
      wantedText.length > 0 &&
      !`${row.title}\n${row.preview}`.toLowerCase().includes(wantedText)
    ) {
      continue;
    }
    const title = row.title.trim();
    const preview = row.preview.trim();
    const updatedAt = isoTimestamp(row.last_modified_time);
    summaries.push({
      persistence: { version: 1, data: { conversationId: row.conversation_id, accountId } },
      cwd: workspace ?? options.cwd ?? "",
      ...(title.length > 0 ? { title } : {}),
      ...(preview.length > 0 ? { description: preview } : {}),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
    if (summaries.length >= limit) break;
  }
  return summaries;
}

/** One conversation index row together with the account whose `agy` wrote it. */
interface AccountRow {
  row: ConversationRow;
  accountId: string;
}

/**
 * Every account's index, in one newest-first list. Each index is already sorted, so the merge is a
 * sort of the concatenation; the sort is stable, which leaves rows of the same timestamp in the
 * order they were read (Default first).
 */
function readConversations(): AccountRow[] {
  const rows: AccountRow[] = [];
  for (const account of listAccounts()) {
    for (const row of readAccountConversations(account.id)) {
      rows.push({ row, accountId: account.id });
    }
  }
  return rows.sort((a, b) => modifiedTime(b.row) - modifiedTime(a.row));
}

function readAccountConversations(accountId: string): ConversationRow[] {
  const path = join(accountGeminiRoot(accountId), "antigravity-cli", "conversation_summaries.db");
  // An account whose CLI has never run has no index at all, which is its normal state, not a
  // fault: sqlite would only report it as "unable to open database file", so it is checked first.
  if (!existsSync(path)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare(SELECT_CONVERSATIONS).all().map(toRow);
  } catch (error) {
    console.error(
      `[antigravity] could not read Antigravity conversations of account ${accountId}: ${describe(error)}`,
    );
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // A database that never opened has nothing to close.
    }
  }
}

/** Antigravity's timestamp as a comparable number; an unparsable one sorts last. */
function modifiedTime(row: ConversationRow): number {
  const parsed = Date.parse(row.last_modified_time.trim().replace(" ", "T"));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toRow(value: Record<string, unknown>): ConversationRow {
  const text = (key: string): string => (typeof value[key] === "string" ? value[key] : "");
  return {
    conversation_id: text("conversation_id"),
    title: text("title"),
    preview: text("preview"),
    last_modified_time: text("last_modified_time"),
    workspace_uris: text("workspace_uris"),
  };
}

/**
 * `workspace_uris` holds a JSON array of `file://` URIs, and is empty for a conversation with no
 * workspace. A malformed value is treated the same as an empty one.
 */
function firstWorkspacePath(workspaceUris: string): string | null {
  if (workspaceUris.trim().length === 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(workspaceUris);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || typeof decoded[0] !== "string") return null;
  try {
    return fileURLToPath(decoded[0]);
  } catch {
    return null;
  }
}

/** Antigravity stores `2026-09-23 13:31:32.28859+00:00`; Paseo expects an ISO timestamp. */
function isoTimestamp(timestamp: string): string | undefined {
  const parsed = new Date(timestamp.trim().replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
