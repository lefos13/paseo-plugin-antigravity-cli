import { isAbsolute, relative } from "node:path";
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import type { AgyToolInfo } from "./protocol";

const SUMMARY_VALUE_LENGTH = 80;
/** Unchanged lines kept around each change, and half the gap that keeps two changes in one hunk. */
const HUNK_CONTEXT = 3;
/** Alignment table cells a changed region may need before it is replaced wholesale. */
const MAX_DIFF_CELLS = 1_000_000;

/**
 * Maps an agy tool step onto the row Paseo renders.
 *
 * `tool_info.parameters` in the stream is not the full argument set: a captured
 * `replace_file_content` step (fixtures/06-edit.ndjson) reports `TargetFile` alone, while the CLI
 * holds `TargetContent` and `ReplacementContent` for that call. The edit mappings below use the
 * parameter names agy documents for its tools — `TargetFile`, `TargetContent`,
 * `ReplacementContent`, `ReplacementChunks[]` (each with `StartLine`, `EndLine`, `TargetContent`,
 * `ReplacementContent`) and `CodeContent` — so a diff is rendered whenever the stream supplies
 * the content. When it does not, the provider compares the file before and after the call and
 * republishes the row with `snapshotDiff` below.
 */
export function mapToolDetail(
  name: string,
  info: AgyToolInfo | undefined,
  cwd: string,
): ProviderToolCallDetail {
  const parameters = info?.parameters ?? {};
  const output = info?.output;
  const text = (key: string): string | undefined => {
    const value = parameters[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const plain = (): ProviderToolCallDetail => ({
    type: "plain_text",
    label: name,
    text: output ?? summarizeParameters(parameters),
  });

  switch (name) {
    case "run_command": {
      const command = text("CommandLine");
      return command
        ? { type: "shell", command, cwd: text("Cwd") ?? cwd, output }
        : plain();
    }
    case "command_status": {
      // The tracked command was started by an earlier run_command, so the id is what names it.
      const commandId = text("CommandId");
      return commandId ? { type: "shell", command: commandId, cwd, output } : plain();
    }
    case "manage_task": {
      const action = text("Action") ?? "manage_task";
      const taskId = text("TaskId");
      const input = text("Input");
      const command = [action, taskId, input ? `(${input})` : ""].filter(Boolean).join(" ");
      return { type: "shell", command: command.length > 0 ? command : "manage_task", cwd, output };
    }
    case "view_file":
    case "read_resource": {
      const filePath = text("AbsolutePath") ?? text("Path");
      return filePath ? { type: "read", filePath } : plain();
    }
    case "write_to_file": {
      const filePath = text("TargetFile") ?? text("AbsolutePath");
      return filePath
        ? { type: "write", filePath, content: text("CodeContent") ?? text("Content") }
        : plain();
    }
    case "replace_file_content":
    case "sed_file": {
      const filePath = text("TargetFile") ?? text("AbsolutePath");
      if (!filePath) return plain();
      const oldString = text("TargetContent");
      const newString = text("ReplacementContent");
      return {
        type: "edit",
        filePath,
        ...(oldString !== undefined ? { oldString } : {}),
        ...(newString !== undefined ? { newString } : {}),
      };
    }
    case "multi_replace_file_content": {
      const filePath = text("TargetFile") ?? text("AbsolutePath");
      if (!filePath) return plain();
      const unifiedDiff = chunksToUnifiedDiff(filePath, cwd, parameters.ReplacementChunks);
      // A chunk the decoder cannot trust is worse than no diff: fall back to the raw parameters.
      return unifiedDiff === null ? plain() : { type: "edit", filePath, unifiedDiff };
    }
    case "call_mcp_tool": {
      const server = text("ServerName");
      const tool = text("ToolName");
      const label = [server, tool].filter((part) => part !== undefined).join("/");
      const args = parameters.Arguments;
      const rendered =
        output ??
        (typeof args === "object" && args !== null && !Array.isArray(args)
          ? summarizeParameters(args as Record<string, unknown>)
          : "");
      return { type: "plain_text", label: label.length > 0 ? label : name, text: rendered };
    }
    case "grep_search":
      return {
        type: "search",
        query: text("Query") ?? text("Pattern") ?? "",
        toolName: "grep",
        content: output,
      };
    case "find_by_name":
    case "list_dir":
      return {
        type: "search",
        query: text("Pattern") ?? text("DirectoryPath") ?? "",
        toolName: "glob",
        content: output,
      };
    case "search_web":
      return {
        type: "search",
        query: text("query") ?? text("Query") ?? "",
        toolName: "web_search",
        content: output,
      };
    case "read_url_content": {
      const url = text("Url") ?? text("URL");
      return url ? { type: "fetch", url, result: output } : plain();
    }
    case "invoke_subagent":
    case "define_subagent":
      return { type: "sub_agent", log: output ?? "", description: text("Description") };
    default:
      return plain();
  }
}

/**
 * One hunk per replacement chunk, so Paseo can render a multi-chunk edit as a single diff.
 * Returns null when any chunk lacks the fields a hunk header and its lines need, because a hunk
 * with invented line numbers would misreport where the change landed.
 */
function chunksToUnifiedDiff(filePath: string, cwd: string, chunks: unknown): string | null {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;

  const hunks: string[] = [];
  // Hunks are listed in file order, so each one shifts the new-file numbering by the change the
  // previous chunk made.
  let offset = 0;
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) return null;
    const record = chunk as Record<string, unknown>;
    const target = record.TargetContent;
    const replacement = record.ReplacementContent;
    const startLine = record.StartLine;
    const endLine = record.EndLine;
    if (typeof target !== "string" || typeof replacement !== "string") return null;
    if (typeof startLine !== "number" || typeof endLine !== "number") return null;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
    if (startLine < 1 || endLine < startLine) return null;

    // A trailing newline terminates the last line rather than starting an empty one.
    const removed = snapshotLines(target);
    const added = snapshotLines(replacement);
    hunks.push(`@@ -${startLine},${removed.length} +${startLine + offset},${added.length} @@`);
    for (const line of removed) hunks.push(`-${line}`);
    for (const line of added) hunks.push(`+${line}`);
    offset += added.length - removed.length;
  }

  return [...diffHeaders(filePath, cwd), ...hunks].join("\n");
}

/**
 * Git-style headers: a path inside the session's workspace is named relative to it, and one
 * outside keeps its absolute form (an `a/` prefix on `/x/y` would double the leading slash).
 */
function diffHeaders(filePath: string, cwd: string): [string, string] {
  const inside = relative(cwd, filePath);
  if (inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside)) {
    return [`--- a/${inside}`, `+++ b/${inside}`];
  }
  return [`--- ${filePath}`, `+++ ${filePath}`];
}

/** True when the row already carries the change, so the file itself need not be compared. */
export function hasEditContent(detail: ProviderToolCallDetail): boolean {
  if (detail.type === "edit") {
    return (
      detail.oldString !== undefined ||
      detail.newString !== undefined ||
      detail.unifiedDiff !== undefined
    );
  }
  return detail.type === "write" && detail.content !== undefined;
}

interface DiffOp {
  readonly kind: "equal" | "remove" | "add";
  readonly line: string;
}

/**
 * Line diff of two snapshots of one file.
 *
 * The common prefix and suffix are trimmed before anything else, so a typical edit only aligns the
 * few lines it touched; a changed region too large for the alignment table is reported as one
 * replacement, which is coarser but still describes the change exactly.
 */
function lineDiff(oldText: string, newText: string): DiffOp[] {
  const before = snapshotLines(oldText);
  const after = snapshotLines(newText);

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const equal = (line: string): DiffOp => ({ kind: "equal", line });
  return [
    ...before.slice(0, head).map(equal),
    ...alignLines(before.slice(head, before.length - tail), after.slice(head, after.length - tail)),
    ...before.slice(before.length - tail).map(equal),
  ];
}

function snapshotLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // A trailing newline terminates the last line rather than starting an empty one.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Longest common subsequence of a changed region, or a wholesale replacement past the cap. */
function alignLines(removed: readonly string[], added: readonly string[]): DiffOp[] {
  if (removed.length === 0) return added.map((line): DiffOp => ({ kind: "add", line }));
  if (added.length === 0) return removed.map((line): DiffOp => ({ kind: "remove", line }));
  if (removed.length * added.length > MAX_DIFF_CELLS) {
    return [
      ...removed.map((line): DiffOp => ({ kind: "remove", line })),
      ...added.map((line): DiffOp => ({ kind: "add", line })),
    ];
  }

  // table[i][j] is the subsequence length of removed[i..] against added[j..], walked backwards
  // from the end so the script can be replayed forwards.
  const width = added.length + 1;
  const table = new Int32Array((removed.length + 1) * width);
  for (let i = removed.length - 1; i >= 0; i -= 1) {
    for (let j = added.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        removed[i] === added[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length && j < added.length) {
    if (removed[i] === added[j]) {
      ops.push({ kind: "equal", line: removed[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: "remove", line: removed[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", line: added[j] });
      j += 1;
    }
  }
  while (i < removed.length) {
    ops.push({ kind: "remove", line: removed[i] });
    i += 1;
  }
  while (j < added.length) {
    ops.push({ kind: "add", line: added[j] });
    j += 1;
  }
  return ops;
}

/** Unified diff of two snapshots, or null when the file is unchanged. */
export function snapshotDiff(
  filePath: string,
  oldText: string,
  newText: string,
  cwd: string,
): string | null {
  const hunks = formatHunks(lineDiff(oldText, newText));
  if (hunks.length === 0) return null;
  return [...diffHeaders(filePath, cwd), ...hunks].join("\n");
}

function formatHunks(ops: readonly DiffOp[]): string[] {
  const changed: number[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].kind !== "equal") changed.push(index);
  }
  if (changed.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const last = ranges.at(-1);
    if (last && index - last.end - 1 <= HUNK_CONTEXT * 2) last.end = index;
    else ranges.push({ start: index, end: index });
  }

  const hunks: string[] = [];
  for (const range of ranges) {
    const start = Math.max(0, range.start - HUNK_CONTEXT);
    const end = Math.min(ops.length - 1, range.end + HUNK_CONTEXT);
    const slice = ops.slice(start, end + 1);
    const before = ops.slice(0, start);
    const oldCount = slice.filter((op) => op.kind !== "add").length;
    const newCount = slice.filter((op) => op.kind !== "remove").length;
    // An empty side names the line its insertion follows, which is one before the usual start.
    const oldStart = before.filter((op) => op.kind !== "add").length + (oldCount === 0 ? 0 : 1);
    const newStart = before.filter((op) => op.kind !== "remove").length + (newCount === 0 ? 0 : 1);
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      const marker = op.kind === "remove" ? "-" : op.kind === "add" ? "+" : " ";
      hunks.push(`${marker}${op.line}`);
    }
  }
  return hunks;
}

export function summarizeParameters(parameters: Record<string, unknown>): string {
  const keys = Object.keys(parameters);
  if (keys.length === 0) return "";
  const parts = keys.slice(0, 4).map((key) => `${key}=${shorten(parameters[key])}`);
  return keys.length > 4 ? `${parts.join(", ")}, …` : parts.join(", ");
}

export function shorten(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw === undefined) return "undefined";
  const single = raw.replace(/\s+/g, " ");
  return single.length > SUMMARY_VALUE_LENGTH
    ? `${single.slice(0, SUMMARY_VALUE_LENGTH)}…`
    : single;
}
