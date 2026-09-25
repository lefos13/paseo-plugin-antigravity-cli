import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { mapToolDetail } from "./tools";

/**
 * Reads the transcript an `invoke_subagent` child writes for itself and turns it into the rows of
 * that child's Paseo session.
 *
 * The file is agy's own trajectory for the child conversation — `~/.gemini/antigravity-cli/brain/
 * <child conversation>/.system_generated/logs/transcript.jsonl`, named by the `log_uri` of the
 * parent's `subagent` step. Every line is one step:
 *
 *   {"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"…"}
 *   {"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
 *    "tool_calls":[{"name":"view_file","args":{"AbsolutePath":"\"/abs/a.txt\""}}]}
 *   {"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","content":"…the result…"}
 *
 * A child whose instruction arrives as a message rather than a user turn opens with
 * `{"type":"SYSTEM_MESSAGE"}` instead of the `USER_INPUT` step — see `childInstruction`.
 *
 * Lines are appended while the child runs, several at once, and a step may land before its
 * predecessor (step 2 before step 1 was observed), so nothing here may assume file order.
 */

/**
 * The step types a child's transcript uses. Anything else is skipped and reported.
 *
 * `SYSTEM_MESSAGE` is not plumbing to be dropped: it carries the child's own instruction, as
 * `[Message] timestamp=… sender=<parent conversation> priority=… content=<prompt>` inside a
 * `<SYSTEM_MESSAGE>` block, and a child that opens with it has no `USER_INPUT` step at all — 1.2.11
 * delivers the parent's `invoke_subagent` prompt this way when it arrives as a message rather than
 * a user turn (probed 2026-09-25, `fixtures/15-subagent-system-message.txt`).
 *
 * `EPHEMERAL_MESSAGE` carries no content: the step holds its own metadata and nothing else, so it
 * is skipped like `GENERIC` rather than reported.
 */
const TRANSCRIPT_USER_INPUT = "USER_INPUT";
const TRANSCRIPT_PLANNER_RESPONSE = "PLANNER_RESPONSE";
const TRANSCRIPT_GENERIC = "GENERIC";
const TRANSCRIPT_SYSTEM_MESSAGE = "SYSTEM_MESSAGE";
const TRANSCRIPT_EPHEMERAL_MESSAGE = "EPHEMERAL_MESSAGE";

/** The tool a child reports to its parent with; the parent conversation id is the recipient. */
const SEND_MESSAGE = "send_message";

export interface TranscriptToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface TranscriptEntry {
  readonly stepIndex: number;
  /** The line's `type`, exactly as written. */
  readonly type: string;
  readonly content?: string;
  readonly toolCalls: readonly TranscriptToolCall[];
}

export interface ParsedTranscript {
  /** In the order the steps were first seen; `renderChild` sorts them. */
  readonly entries: TranscriptEntry[];
  /** Complete lines that were not a JSON step, reported instead of thrown away silently. */
  readonly malformed: number;
}

/**
 * Parses what a transcript holds right now. Only complete lines count: the last line of a file
 * being appended to is a write in progress, not a broken step.
 */
export function parseTranscriptLines(text: string): ParsedTranscript {
  // `split` never loses a trailing newline's emptiness: dropping the final element drops either
  // that empty tail or the unterminated line itself.
  const complete = text.split("\n").slice(0, -1);
  const byStep = new Map<number, TranscriptEntry>();
  let malformed = 0;

  for (const line of complete) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      malformed += 1;
      continue;
    }
    const record = decoded as Record<string, unknown>;
    const stepIndex = record.step_index;
    const type = record.type;
    if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex)) {
      malformed += 1;
      continue;
    }
    if (typeof type !== "string" || type.length === 0) {
      malformed += 1;
      continue;
    }
    byStep.set(stepIndex, {
      stepIndex,
      type,
      ...(typeof record.content === "string" ? { content: record.content } : {}),
      toolCalls: readToolCalls(record.tool_calls),
    });
  }

  return { entries: [...byStep.values()], malformed };
}

function readToolCalls(value: unknown): TranscriptToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: TranscriptToolCall[] = [];
  for (const call of value) {
    if (typeof call !== "object" || call === null || Array.isArray(call)) continue;
    const record = call as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    const args = record.args;
    calls.push({
      name: record.name,
      args: typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
    });
  }
  return calls;
}

export interface DecodedArgs {
  /** The call's parameters, without agy's own two bookkeeping keys. */
  readonly parameters: Record<string, unknown>;
  /** What the child said it was doing, for the action list. */
  readonly toolSummary?: string;
  readonly toolAction?: string;
}

/**
 * Decodes one tool call's arguments. agy JSON-encodes every value — `"\"\/abs\/a.txt\""` is the
 * path `/abs/a.txt`, `"true"` is a boolean — so a value that parses as JSON is taken as JSON and
 * anything else is kept verbatim. `toolAction` and `toolSummary` are the child's own narration of
 * the call, not arguments to it, so they are lifted out of `parameters`.
 */
export function decodeArgs(args: Record<string, unknown>): DecodedArgs {
  const parameters: Record<string, unknown> = {};
  let toolSummary: string | undefined;
  let toolAction: string | undefined;

  for (const [key, value] of Object.entries(args)) {
    let decoded = value;
    if (typeof value === "string") {
      try {
        decoded = JSON.parse(value);
      } catch {
        decoded = value;
      }
    }
    if (key === "toolSummary") {
      if (typeof decoded === "string") toolSummary = decoded;
      continue;
    }
    if (key === "toolAction") {
      if (typeof decoded === "string") toolAction = decoded;
      continue;
    }
    parameters[key] = decoded;
  }

  return {
    parameters,
    ...(toolSummary !== undefined ? { toolSummary } : {}),
    ...(toolAction !== undefined ? { toolAction } : {}),
  };
}

export interface ChildAction {
  readonly index: number;
  readonly toolName: string;
  readonly summary?: string;
}

export interface ChildRender {
  /** Every row the child's steps justify, sorted by step index. */
  readonly items: ProviderTimelineItem[];
  /**
   * Whether the child has finished. `send_message` — the parent's own notification — is not used
   * for this: it reaches the parent's stream about 26 s after the child's transcript already held
   * its last line, and it names no child, so two siblings arriving together cannot be told apart.
   * What does say it is the child's own last word: a PLANNER_RESPONSE with text and no tool calls,
   * as the highest step so far.
   */
  readonly done: boolean;
  /** The child's report to its parent, else whatever it said last. */
  readonly report: string;
  readonly actions: readonly ChildAction[];
  /** Step types this plugin does not know, reported rather than guessed at. */
  readonly unknownTypes: readonly string[];
}

export interface ChildContext {
  readonly childConversationId: string;
  readonly parentConversationId: string;
  readonly cwd: string;
}

/** Renders a child's transcript into Paseo rows. Pure: the same entries always render the same. */
export function renderChild(
  entries: readonly TranscriptEntry[],
  context: ChildContext,
): ChildRender {
  const sorted = [...entries].sort((left, right) => left.stepIndex - right.stepIndex);
  const items: ProviderTimelineItem[] = [];
  const actions: ChildAction[] = [];
  const unknownTypes: string[] = [];
  let report = "";
  let lastText = "";
  // One-based: Paseo's `sub_agent` schema is `index: z.number().int().positive()`, so an action
  // list that starts at 0 is a decode failure on the host, which fails the whole session rather
  // than dropping the row.
  let actionIndex = 1;

  for (let position = 0; position < sorted.length; position += 1) {
    const entry = sorted[position];
    if (entry === undefined) continue;

    if (entry.type === TRANSCRIPT_USER_INPUT || entry.type === TRANSCRIPT_SYSTEM_MESSAGE) {
      items.push({
        type: "user_message",
        id: childItemId(context, entry.stepIndex, "user"),
        text: childInstruction(entry),
      });
      continue;
    }

    if (entry.type === TRANSCRIPT_PLANNER_RESPONSE) {
      const content = entry.content ?? "";
      if (content.trim().length > 0) {
        items.push({
          type: "assistant_message",
          id: childItemId(context, entry.stepIndex, "msg"),
          text: content,
        });
        lastText = content;
      }
      // The GENERIC lines between this response and the next one are its tool results, in call
      // order: the k-th result belongs to the k-th call.
      const results: string[] = [];
      for (let scan = position + 1; scan < sorted.length; scan += 1) {
        const next = sorted[scan];
        if (next === undefined || next.type !== TRANSCRIPT_GENERIC) break;
        results.push(next.content ?? "");
      }
      entry.toolCalls.forEach((call, index) => {
        const decoded = decodeArgs(call.args);
        const output = results[index];
        const id = `${childItemId(context, entry.stepIndex, "tool")}:${index}`;
        const detail = mapToolDetail(
          call.name,
          {
            name: call.name,
            parameters: decoded.parameters,
            ...(output !== undefined ? { output } : {}),
          },
          context.cwd,
        );
        items.push(
          output === undefined
            ? { type: "tool_call", id, callId: id, name: call.name, detail, status: "running", error: null }
            : { type: "tool_call", id, callId: id, name: call.name, detail, status: "completed", error: null },
        );
        actions.push({
          index: actionIndex,
          toolName: call.name,
          ...(decoded.toolSummary !== undefined ? { summary: decoded.toolSummary } : {}),
        });
        actionIndex += 1;
        if (call.name !== SEND_MESSAGE) return;
        const recipient = decoded.parameters.Recipient;
        const message = decoded.parameters.Message;
        // A child may message another child; only what it sends its parent is its report.
        if (recipient === context.parentConversationId && typeof message === "string") {
          report = message;
        }
      });
      continue;
    }

    // GENERIC holds a tool result (mapped with the call above it) and EPHEMERAL_MESSAGE holds
    // nothing at all, so neither is a row of its own.
    if (entry.type === TRANSCRIPT_GENERIC || entry.type === TRANSCRIPT_EPHEMERAL_MESSAGE) continue;
    if (!unknownTypes.includes(entry.type)) unknownTypes.push(entry.type);
  }

  const last = sorted.at(-1);
  const done =
    last !== undefined &&
    last.type === TRANSCRIPT_PLANNER_RESPONSE &&
    last.toolCalls.length === 0 &&
    (last.content ?? "").trim().length > 0;

  return {
    items,
    done,
    report: report.length > 0 ? report : lastText,
    actions,
    unknownTypes,
  };
}

/**
 * Ids are derived from the child conversation and the step, never from arrival order, because the
 * same transcript is rendered again on every read and replayed from the store on a reload.
 */
function childItemId(context: ChildContext, stepIndex: number, kind: string): string {
  return `agy-sub:${context.childConversationId}:${stepIndex}:${kind}`;
}

/**
 * The instruction a child was given, out of the envelope agy delivered it in — `USER_INPUT` wraps
 * it in `<USER_REQUEST>` and appends its own metadata, `SYSTEM_MESSAGE` wraps it as
 * `[Message] timestamp=… sender=… priority=… content=<the prompt>` inside `<SYSTEM_MESSAGE>`.
 * Either way only the instruction is a row: the envelope and its metadata are model-facing, and a
 * step in neither shape keeps its own text rather than losing it to a changed envelope.
 */
function childInstruction(entry: TranscriptEntry): string {
  const content = entry.content ?? "";
  if (entry.type !== TRANSCRIPT_SYSTEM_MESSAGE) {
    const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
    return (match?.[1] ?? content).trim();
  }
  const block = /<SYSTEM_MESSAGE>([\s\S]*?)<\/SYSTEM_MESSAGE>/.exec(content)?.[1]?.trim();
  if (block === undefined) return content.trim();
  // The metadata is a `key=value` run before the payload, so the payload is everything after the
  // first `content=`.
  const payload = block.indexOf("content=");
  return (payload === -1 ? block : block.slice(payload + "content=".length)).trim();
}

/** A transcript larger than this is not re-read on every tick. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** Poll period. `fs.watch` says when to look; this covers an event that never arrived. */
const POLL_MS = 500;
/** How long a transcript that never yields a valid entry is followed before giving up on it. */
const NO_ENTRY_MS = 60_000;
/** How long a child that stopped writing is followed before its transcript is given up on. */
const NO_GROWTH_MS = 10 * 60_000;

export interface SubagentTranscriptHandlers {
  /** Called for every read; `changed` holds only the rows whose JSON moved since the last one. */
  onRender(render: ChildRender, changed: readonly ProviderTimelineItem[]): void;
  /** The transcript cannot be followed at all, so the row keeps whatever the stream said. */
  onDegrade(reason: string): void;
  /** Following stopped while the child was still going. */
  onLost(reason: string): void;
}

export interface SubagentTranscriptConfig extends ChildContext {
  readonly logUri: string;
}

/**
 * Follows one child's transcript: watches the file, re-reads it, and hands each render to a
 * consumer that publishes what changed. Every path that stops following goes through `stop`, so no
 * watcher and no timer outlives the reason it was started.
 */
export class SubagentTranscript {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** The read under way, if any: a second one would only race this one to the same file. */
  private inFlight: Promise<void> | null = null;
  /** The JSON last published per row id, which is what makes a re-render publish nothing. */
  private readonly published = new Map<string, string>();
  private readonly startedAt = Date.now();
  private lastGrowthAt = Date.now();
  private lastStamp = "";
  private sawEntry = false;
  private malformedSeen = 0;
  private unknownSeen = "";
  /** Resolved once: a log_uri that is not a file URL can never be followed. */
  private readonly path: string | null;

  constructor(
    private readonly config: SubagentTranscriptConfig,
    private readonly handlers: SubagentTranscriptHandlers,
  ) {
    this.path = transcriptFilePath(config.logUri);
  }

  start(): void {
    const path = this.path;
    if (this.stopped) return;
    if (path === null) {
      this.degrade("its log_uri is not a file: URL");
      return;
    }

    // While the file does not exist yet there is nothing to watch, but its directory will tell us
    // when it appears; a directory that does not exist either leaves the poll to notice both.
    const target = existsSync(path) ? path : existsSync(dirname(path)) ? dirname(path) : null;
    if (target !== null) {
      try {
        const watcher = watch(target, () => void this.read());
        // The poll is the fallback for every case this cannot report (a moved file, a full watch
        // queue), so a watch error is not worth stopping for.
        watcher.on("error", () => undefined);
        watcher.unref();
        this.watcher = watcher;
      } catch {
        this.watcher = null;
      }
    }

    this.timer = setInterval(() => void this.read(), POLL_MS);
    this.timer.unref();
    void this.read();
  }

  /** Stops watching and polling. Published rows are left as they are. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One last look at the transcript, for the callers that stop following while a child runs. */
  async readFinal(): Promise<void> {
    if (this.stopped) return;
    // A read may already be under way — from the poll, the watch, or the read `start` issued — and
    // it was started before this call, so what it publishes goes first. Giving up here instead
    // would turn the caller's "one last read" into no read at all whenever a tick happened to be
    // running, which is the one moment it matters most.
    await this.inFlight;
    // That read may have found the child's last word, which stops the tailer; there is nothing
    // more to look at then.
    if (this.stopped) return;
    // Otherwise one read of its own: the file is very likely unchanged since the last tick, and
    // the point here is to publish what it holds now rather than to wait for it to move.
    this.lastStamp = "";
    await this.read();
  }

  /** Starts a read unless one is in flight, which it then joins. */
  private read(): Promise<void> {
    const inFlight = this.inFlight;
    if (inFlight) return inFlight;
    const read = this.readOnce()
      .catch((error: unknown) => {
        // Whatever went wrong in reading or in rendering, following this child is what pays for
        // it: the row keeps what the parent's stream said, and the parent's turn is untouched.
        this.degrade(`its transcript could not be followed: ${describe(error)}`);
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = read;
    return read;
  }

  private async readOnce(): Promise<void> {
    const path = this.path;
    if (path === null || this.stopped) return;

    let size: number;
    let mtimeMs: number;
    try {
      const stats = await stat(path);
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Not there yet (or gone): the poll and the watch both bring us back.
      this.checkBounds();
      return;
    }
    // `stop` takes effect the moment it is called, including while this read was waiting: what a
    // stopped tailer has already begun to read is no longer anything it may publish.
    if (this.stopped) return;

    if (size > MAX_TRANSCRIPT_BYTES) {
      this.degrade(`its transcript grew past ${Math.round(MAX_TRANSCRIPT_BYTES / 1024 / 1024)} MiB`);
      return;
    }
    const stamp = `${size}:${mtimeMs}`;
    if (stamp === this.lastStamp) {
      this.checkBounds();
      return;
    }
    this.lastStamp = stamp;
    this.lastGrowthAt = Date.now();

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.degrade(`its transcript could not be read: ${describe(error)}`);
      return;
    }
    if (this.stopped) return;
    this.publish(text);
    this.checkBounds();
  }

  private publish(text: string): void {
    const parsed = parseTranscriptLines(text);
    if (parsed.malformed > this.malformedSeen) {
      this.malformedSeen = parsed.malformed;
      console.error(
        `[antigravity] ${parsed.malformed} unreadable line(s) in the subagent transcript ${this.config.childConversationId}`,
      );
    }

    const render = renderChild(parsed.entries, this.config);
    const unknown = render.unknownTypes.join(", ");
    if (unknown.length > 0 && unknown !== this.unknownSeen) {
      this.unknownSeen = unknown;
      console.error(
        `[antigravity] ignoring unknown step type(s) in the subagent transcript ${this.config.childConversationId}: ${unknown}`,
      );
    }
    const changed: ProviderTimelineItem[] = [];
    for (const item of render.items) {
      const json = JSON.stringify(item);
      if (this.published.get(item.id) === json) continue;
      this.published.set(item.id, json);
      changed.push(item);
    }
    if (render.items.length > 0) this.sawEntry = true;
    this.handlers.onRender(render, changed);
  }

  private checkBounds(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (!this.sawEntry) {
      if (now - this.startedAt > NO_ENTRY_MS) this.degrade("no step appeared in its transcript");
      return;
    }
    if (now - this.lastGrowthAt > NO_GROWTH_MS) this.lose();
  }

  private degrade(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.handlers.onDegrade(reason);
  }

  private lose(): void {
    if (this.stopped) return;
    this.stop();
    this.handlers.onLost("Stopped following the subagent transcript");
  }
}

/**
 * The local file a `log_uri` names, or null for anything else: an http URL, or a value that is not
 * a URL at all, names nothing this plugin could read.
 */
export function transcriptFilePath(logUri: string): string | null {
  try {
    const url = new URL(logUri);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
