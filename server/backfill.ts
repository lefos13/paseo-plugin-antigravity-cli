import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { decodeArgs, parseTranscriptLines, type TranscriptEntry } from "./subagents";
import { mapToolDetail } from "./tools";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Recovers a turn whose stream-json output agy has stopped delivering.
 *
 * agy prints a turn's steps strictly in order, and a `run_command` that moved to the background
 * stays ACTIVE on the stream until that background task ends. Every step after it — and the turn's
 * `result` — is held back until then, while the conversation itself carries on and finishes
 * (probed with agy 1.2.10: a `sleep 40` sent to the background held three later steps for 40 s;
 * a dev server held them for good). The conversation's own transcript is written as the steps
 * happen, so it is what the plugin reads while the stream is stuck.
 *
 * Stream and transcript share step indices: an `agent_response` step on the stream is the
 * transcript's PLANNER_RESPONSE at the same index, and the k-th tool it called is the step at
 * `index + 1 + k`, whose GENERIC line is that call's result.
 */

const PLANNER_RESPONSE = "PLANNER_RESPONSE";
const GENERIC = "GENERIC";
const USER_INPUT = "USER_INPUT";
const SYSTEM_MESSAGE = "SYSTEM_MESSAGE";

/** A `run_command` result saying agy moved the command to the background, naming its task. */
const BACKGROUND_LAUNCH = /Tool is running as a background task with task id: (\S+)/;
/** The SYSTEM_MESSAGE agy injects when a background task ends (agy 1.2.x). */
const BACKGROUND_FINISH = /Task id "([^"]+)" finished/g;
/** The SYSTEM_MESSAGE a fresh CLI injects about tasks its predecessor left behind. */
const BACKGROUND_STOPPED = /background tasks have been stopped/;
/** Where agy writes the log of a background task, inside the conversation's brain directory. */
const TASK_LOGS = "/.system_generated/tasks/";

/**
 * Where agy writes a conversation's transcript. The caller names the `.gemini` root: the real home
 * for a Default session, the session's account shadow home otherwise — the CLI runs under that
 * account's `HOME`, so its brain directory is the account's, not the daemon's.
 */
export function conversationTranscriptPath(geminiRoot: string, conversationId: string): string {
  return join(
    geminiRoot,
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

export interface BackfillIds {
  message(stepIndex: number): string;
  tool(stepIndex: number): string;
}

export interface BackfillRow {
  /** The stream step this row stands for. */
  readonly stepIndex: number;
  readonly item: ProviderTimelineItem;
}

export interface Backfill {
  /** Every row the transcript justifies, in step order. */
  readonly rows: BackfillRow[];
  /**
   * The step holding the conversation's final answer — a PLANNER_RESPONSE with text and no tool
   * calls as the highest step so far — or null while it is still working. An answer that is only
   * the model waiting for a background command is not final (see `backgroundState`).
   */
  readonly finalStep: number | null;
  readonly finalText: string;
  /** Background commands started since the latest user input that have not finished yet. */
  readonly backgroundTasks: number;
}

/** Renders a conversation transcript into rows keyed the way the stream keys the same steps. */
export function renderBackfill(
  entries: readonly TranscriptEntry[],
  ids: BackfillIds,
  cwd: string,
): Backfill {
  const byStep = new Map(entries.map((entry) => [entry.stepIndex, entry]));
  const sorted = [...byStep.values()].sort((left, right) => left.stepIndex - right.stepIndex);
  const rows: BackfillRow[] = [];

  for (const entry of sorted) {
    if (entry.type !== PLANNER_RESPONSE) continue;
    const content = entry.content ?? "";
    if (content.trim().length > 0) {
      rows.push({
        stepIndex: entry.stepIndex,
        item: { type: "assistant_message", id: ids.message(entry.stepIndex), text: content },
      });
    }
    entry.toolCalls.forEach((call, index) => {
      const stepIndex = entry.stepIndex + 1 + index;
      const result = byStep.get(stepIndex);
      const output = result?.type === GENERIC ? (result.content ?? "") : undefined;
      const { parameters } = decodeArgs(call.args);
      const id = ids.tool(stepIndex);
      const detail = mapToolDetail(
        call.name,
        { name: call.name, parameters, ...(output !== undefined ? { output } : {}) },
        cwd,
      );
      const base = {
        type: "tool_call" as const,
        id,
        callId: id,
        name: call.name,
        detail,
        metadata: { stepIndex, parameters: structuredClone(parameters) as JsonValue },
        error: null,
      };
      rows.push({
        stepIndex,
        item: output === undefined ? { ...base, status: "running" } : { ...base, status: "completed" },
      });
    });
  }

  const last = sorted.at(-1);
  const answered =
    last !== undefined &&
    last.type === PLANNER_RESPONSE &&
    last.toolCalls.length === 0 &&
    (last.content ?? "").trim().length > 0;
  const background = backgroundState(sorted);
  const done = answered && !background.waiting;
  return {
    rows,
    finalStep: done ? last.stepIndex : null,
    finalText: done ? (last.content ?? "") : "",
    backgroundTasks: background.running,
  };
}

/**
 * The background commands of the current turn, and whether its latest answer only waits for one.
 *
 * agy tells the model a command went to the background with "either proceed to other relevant
 * work, or simply update the user with a short message … and end the turn", then keeps the turn
 * open itself ("root agent idle; waiting up to 30m0s for 1 background task(s)" on stderr) and hands
 * the model the task's result when it ends, in the same turn (probed with agy 1.2.14 on
 * `sleep 20`). An answer whose latest tool result is such a launch is that short message: the
 * turn is not over. Checking on the task in between — `manage_task status`, reading its log, as
 * gemini-3.8-flash did on the same probe — is still waiting. An answer after other work — a dev
 * server started and then checked — is the end of the turn.
 */
function backgroundState(sorted: readonly TranscriptEntry[]): { running: number; waiting: boolean } {
  let start = 0;
  sorted.forEach((entry, index) => {
    if (entry.type === USER_INPUT) start = index + 1;
  });
  const running = new Set<string>();
  const calls = new Map<number, string>();
  let latestResultTask: string | null = null;
  for (const entry of sorted.slice(start)) {
    const content = entry.content ?? "";
    if (entry.type === PLANNER_RESPONSE) {
      entry.toolCalls.forEach((call, index) => {
        calls.set(entry.stepIndex + 1 + index, `${call.name} ${JSON.stringify(call.args)}`);
      });
    } else if (entry.type === GENERIC) {
      const launch = BACKGROUND_LAUNCH.exec(content);
      if (launch) {
        latestResultTask = launch[1];
        running.add(launch[1]);
      } else if (!checksOnTask(calls.get(entry.stepIndex), running)) {
        latestResultTask = null;
      }
    } else if (entry.type === SYSTEM_MESSAGE) {
      for (const finish of content.matchAll(BACKGROUND_FINISH)) running.delete(finish[1]);
      if (BACKGROUND_STOPPED.test(content)) running.clear();
    }
  }
  return {
    running: running.size,
    waiting: latestResultTask !== null && running.has(latestResultTask),
  };
}

/** Whether a tool call only looks in on a running background task: its status, or its log. */
function checksOnTask(call: string | undefined, running: ReadonlySet<string>): boolean {
  if (call === undefined) return false;
  if (call.startsWith("manage_task ")) return true;
  if (call.includes(TASK_LOGS)) return true;
  for (const task of running) if (call.includes(task)) return true;
  return false;
}

/** Poll period while a stream is stuck. */
const POLL_MS = 1_000;
/** A transcript larger than this is not re-read on every tick. */
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/**
 * Re-reads one conversation transcript whenever it changes and hands its entries on. Started only
 * while a turn has a tool that has not reported back, and stopped with that turn.
 */
export class TranscriptPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private reading = false;
  private lastStamp = "";

  constructor(
    private readonly path: string,
    private readonly onEntries: (entries: readonly TranscriptEntry[]) => void,
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      const stats = await stat(this.path);
      if (stats.size > MAX_TRANSCRIPT_BYTES) {
        console.error(`[antigravity] not following ${this.path}: it is larger than 32 MiB`);
        this.stop();
        return;
      }
      const stamp = `${stats.size}:${stats.mtimeMs}`;
      if (stamp === this.lastStamp) return;
      this.lastStamp = stamp;
      const text = await readFile(this.path, "utf8");
      if (this.stopped) return;
      this.onEntries(parseTranscriptLines(text).entries);
    } catch (error) {
      // Not written yet, or pruned: the next tick looks again.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[antigravity] could not read ${this.path}: ${String(error)}`);
      }
    } finally {
      this.reading = false;
    }
  }
}
