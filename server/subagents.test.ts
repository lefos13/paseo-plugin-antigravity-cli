import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  SubagentTranscript,
  decodeArgs,
  parseTranscriptLines,
  renderChild,
  type ChildContext,
  type SubagentTranscriptConfig,
  type SubagentTranscriptHandlers,
  type TranscriptEntry,
} from "./subagents";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

/** The parent conversation of fixtures/12-subagents.ndjson: what a child addresses its report to. */
const PARENT = "fff372d8-ed2b-4411-b145-836c9e0726e7";
const CWD = "/Users/dev/agy-subagent-probe2";
const CHILD_A = "15363ad9-3485-4249-aee7-a7605879f405";
const CHILD_B = "3222e2ba-df81-4e8f-8321-4c1bf895f37e";
/** The child of fixtures/15, whose instruction arrived in a `SYSTEM_MESSAGE` envelope. */
const CHILD_C = "17e88fd5-83b8-4ba0-a872-23f152233f00";

function captured(childConversationId: string): string {
  return readFileSync(`${fixturesDir}/12-subagent-${childConversationId}.transcript.jsonl`, "utf8");
}

function context(childConversationId: string): ChildContext {
  return { childConversationId, parentConversationId: PARENT, cwd: CWD };
}

/** The two children captured alongside fixtures/12-subagents.ndjson, as their own lines read now. */
function capturedRender(childConversationId: string) {
  const parsed = parseTranscriptLines(captured(childConversationId));
  expect(parsed.malformed).toBe(0);
  expect(parsed.entries).toHaveLength(6);
  return renderChild(parsed.entries, context(childConversationId));
}

function entry(overrides: Partial<TranscriptEntry> & { stepIndex: number; type: string }): TranscriptEntry {
  return { toolCalls: [], ...overrides };
}

describe("parseTranscriptLines", () => {
  it("reads every complete step of a captured child transcript", () => {
    const parsed = parseTranscriptLines(captured(CHILD_A));
    expect(parsed.malformed).toBe(0);
    expect(parsed.entries.map((item) => item.stepIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(parsed.entries.map((item) => item.type)).toEqual([
      "USER_INPUT",
      "PLANNER_RESPONSE",
      "GENERIC",
      "PLANNER_RESPONSE",
      "GENERIC",
      "PLANNER_RESPONSE",
    ]);
  });

  it("keeps only complete lines, because the last one is a write in progress", () => {
    const complete = '{"step_index":0,"type":"USER_INPUT","content":"hi"}\n';
    expect(parseTranscriptLines(complete).entries).toHaveLength(1);
    // The same line without its newline is half a write, not a step.
    expect(parseTranscriptLines(complete.trimEnd()).entries).toHaveLength(0);
    expect(parseTranscriptLines(complete.trimEnd()).malformed).toBe(0);
  });

  it("replaces an earlier line that reported the same step index", () => {
    const text =
      '{"step_index":1,"type":"PLANNER_RESPONSE","content":"first"}\n' +
      '{"step_index":1,"type":"PLANNER_RESPONSE","content":"second"}\n';
    const parsed = parseTranscriptLines(text);
    expect(parsed.entries).toEqual([
      { stepIndex: 1, type: "PLANNER_RESPONSE", content: "second", toolCalls: [] },
    ]);
  });

  it("counts unreadable lines instead of throwing and skips blank ones", () => {
    const text = '{"step_index":0,"type":"USER_INPUT"}\nnot json\n{"no_step":true}\n\n[1,2]\n';
    const parsed = parseTranscriptLines(text);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.malformed).toBe(3);
  });
});

describe("decodeArgs", () => {
  it("decodes the JSON every value is wrapped in, and lifts out the child's own narration", () => {
    // Copied from the captured transcript: values are JSON-encoded strings, and the last two keys
    // are what the child said it was doing rather than arguments to the call.
    expect(
      decodeArgs({
        AbsolutePath: '"/Users/dev/agy-subagent-probe2/a.txt"',
        toolAction: '"Reading a.txt"',
        toolSummary: '"Read a.txt"',
      }),
    ).toEqual({
      parameters: { AbsolutePath: "/Users/dev/agy-subagent-probe2/a.txt" },
      toolAction: "Reading a.txt",
      toolSummary: "Read a.txt",
    });
  });

  it("keeps a value that is not JSON as it was, and passes non-strings through", () => {
    expect(decodeArgs({ Command: "ls -la", Count: 3, Nested: { a: 1 } })).toEqual({
      parameters: { Command: "ls -la", Count: 3, Nested: { a: 1 } },
    });
  });
});

describe("renderChild on the captured transcripts", () => {
  it("renders the child's prompt, its calls, and its answer", () => {
    const render = capturedRender(CHILD_A);
    expect(render.items.map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
    expect(render.items[0]).toMatchObject({
      id: `agy-sub:${CHILD_A}:0:user`,
      // The `<ADDITIONAL_METADATA>` agy appends is not part of the child's instructions.
      text: "Please read the file /Users/dev/agy-subagent-probe2/a.txt and report its exact contents.",
    });
    expect(render.items[1]).toMatchObject({
      id: `agy-sub:${CHILD_A}:1:tool:0`,
      callId: `agy-sub:${CHILD_A}:1:tool:0`,
      name: "view_file",
      // The GENERIC line after the call is its result, which is what makes it completed.
      status: "completed",
      error: null,
      detail: { type: "read", filePath: `${CWD}/a.txt` },
    });
    expect(render.items[2]).toMatchObject({
      name: "send_message",
      status: "completed",
      detail: { type: "plain_text", label: "send_message" },
    });
    expect(render.items[3]).toMatchObject({
      id: `agy-sub:${CHILD_A}:5:msg`,
      text: "I have read the contents of `/Users/dev/agy-subagent-probe2/a.txt` and reported them back to the parent agent.",
    });
  });

  it("takes the report a child sent its parent and the summary of every call", () => {
    const render = capturedRender(CHILD_A);
    expect(render.report).toBe(
      "The file `/Users/dev/agy-subagent-probe2/a.txt` contains:\n\n```\nalpha\n```\n(followed by a trailing newline)",
    );
    expect(render.actions).toEqual([
      // One-based, as Paseo's `sub_agent` schema requires.
      { index: 1, toolName: "view_file", summary: "Read a.txt" },
      { index: 2, toolName: "send_message", summary: "Report a.txt contents" },
    ]);
    expect(render.unknownTypes).toEqual([]);
  });

  it("sees a child whose last word is text and no call as finished", () => {
    // Both captured children end with a PLANNER_RESPONSE carrying text and no tool_calls.
    expect(capturedRender(CHILD_A).done).toBe(true);
    expect(capturedRender(CHILD_B).done).toBe(true);
    expect(capturedRender(CHILD_B).report).toContain("beta");
  });

  it("renders the instruction that arrived as a system message", () => {
    // fixtures/15: 1.2.11 delivers the parent's instruction in a `<SYSTEM_MESSAGE>` envelope, with
    // `[Message] timestamp=… sender=… priority=… content=<the prompt>` inside it, and such a child
    // has no `USER_INPUT` step at all — so this is the child's prompt, not an unknown step.
    const text = readFileSync(
      `${fixturesDir}/15-subagent-system-message.transcript.jsonl`,
      "utf8",
    );
    const parsed = parseTranscriptLines(text);
    expect(parsed.malformed).toBe(0);
    const render = renderChild(parsed.entries, context(CHILD_C));

    expect(render.unknownTypes).toEqual([]);
    expect(render.items.map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "assistant_message",
    ]);
    expect(render.items[0]).toMatchObject({
      id: `agy-sub:${CHILD_C}:0:user`,
      // The preamble and the `[Message] … priority=…` metadata around it are not the instruction.
      text:
        "Please read README.md in the current workspace (do not modify any files). Return:\n" +
        "1. The title line of the file (e.g. the first header or # line).\n" +
        "2. The number of top-level '##' (H2) sections in the file.",
    });
    expect(render.items[1]).toMatchObject({
      name: "run_command",
      status: "completed",
      detail: { type: "shell", command: "ls -la /Users/dev/agy-subagent-probe3" },
    });
    expect(render.items[2]).toMatchObject({
      id: `agy-sub:${CHILD_C}:3:msg`,
      text: "I have analyzed `README.md` and sent the results back to the parent agent.",
    });
    expect(render.done).toBe(true);
  });

  it("renders the same rows however the lines arrived", () => {
    // Captured from real streams: a child writes several steps at once and may write step 2 before
    // step 1. The render must not depend on file order.
    const lines = captured(CHILD_A).split("\n").filter((line) => line.trim().length > 0);
    const shuffled = [lines[0], lines[2], lines[1], lines[3], lines[4], lines[5]];
    const forward = parseTranscriptLines(`${lines.join("\n")}\n`);
    const reordered = parseTranscriptLines(`${shuffled.join("\n")}\n`);
    expect(renderChild(reordered.entries, context(CHILD_A))).toEqual(
      renderChild(forward.entries, context(CHILD_A)),
    );
  });
});

describe("renderChild", () => {
  it("leaves a call that has no result yet running", () => {
    const render = renderChild(
      [
        entry({ stepIndex: 0, type: "PLANNER_RESPONSE", toolCalls: [{ name: "view_file", args: { AbsolutePath: '"/a.txt"' } }] }),
      ],
      context(CHILD_A),
    );
    expect(render.items).toEqual([
      {
        type: "tool_call",
        id: `agy-sub:${CHILD_A}:0:tool:0`,
        callId: `agy-sub:${CHILD_A}:0:tool:0`,
        name: "view_file",
        detail: { type: "read", filePath: "/a.txt" },
        status: "running",
        error: null,
      },
    ]);
    // The highest step is that call, so the child has not finished.
    expect(render.done).toBe(false);
  });

  it("pairs each result with the call at its own position", () => {
    const render = renderChild(
      [
        entry({
          stepIndex: 0,
          type: "PLANNER_RESPONSE",
          toolCalls: [
            { name: "run_command", args: { CommandLine: '"ls"' } },
            { name: "run_command", args: { CommandLine: '"pwd"' } },
          ],
        }),
        entry({ stepIndex: 1, type: "GENERIC", content: "first result" }),
        entry({ stepIndex: 2, type: "GENERIC", content: "second result" }),
      ],
      context(CHILD_A),
    );
    expect(render.items).toMatchObject([
      { name: "run_command", status: "completed", detail: { command: "ls", output: "first result" } },
      { name: "run_command", status: "completed", detail: { command: "pwd", output: "second result" } },
    ]);
  });

  it("falls back to the child's last text when it never messaged its parent", () => {
    const render = renderChild(
      [
        entry({
          stepIndex: 0,
          type: "PLANNER_RESPONSE",
          toolCalls: [
            {
              name: "send_message",
              args: { Recipient: '"someone-else"', Message: '"a sibling"' },
            },
          ],
        }),
        entry({ stepIndex: 1, type: "PLANNER_RESPONSE", content: "done here" }),
      ],
      context(CHILD_A),
    );
    expect(render.report).toBe("done here");
  });

  it("reports a step type it does not know instead of guessing at it", () => {
    const render = renderChild(
      [entry({ stepIndex: 0, type: "FOO", content: "?" }), entry({ stepIndex: 1, type: "FOO" })],
      context(CHILD_A),
    );
    expect(render.unknownTypes).toEqual(["FOO"]);
    expect(render.items).toEqual([]);
    expect(render.done).toBe(false);
  });

  it("skips an empty ephemeral step rather than reporting it", () => {
    // Probed 2026-09-25: 1.2.11 child transcripts carry `EPHEMERAL_MESSAGE` steps that hold
    // nothing but their own metadata, so there is no row to make from one.
    const render = renderChild(
      [
        entry({ stepIndex: 0, type: "EPHEMERAL_MESSAGE" }),
        entry({ stepIndex: 1, type: "PLANNER_RESPONSE", content: "done here" }),
      ],
      context(CHILD_A),
    );
    expect(render.unknownTypes).toEqual([]);
    expect(render.items.map((item) => item.type)).toEqual(["assistant_message"]);
  });

  it("keeps a system message's own text when the envelope is not the shape it knows", () => {
    const first = (content: string) =>
      renderChild([entry({ stepIndex: 0, type: "SYSTEM_MESSAGE", content })], context(CHILD_A)).items[0];
    expect(first("just the instruction")).toMatchObject({ text: "just the instruction" });
    expect(first("<SYSTEM_MESSAGE>\nno metadata here\n</SYSTEM_MESSAGE>")).toMatchObject({
      text: "no metadata here",
    });
  });

  it("does not treat a last response that still calls a tool as finished", () => {
    const render = renderChild(
      [entry({ stepIndex: 0, type: "PLANNER_RESPONSE", content: "thinking", toolCalls: [{ name: "view_file", args: {} }] })],
      context(CHILD_A),
    );
    expect(render.done).toBe(false);
  });
});

describe("SubagentTranscript", () => {
  const CHILD = "aaaaaaaa-0000-4000-8000-000000000000";

  function line(stepIndex: number, type: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ step_index: stepIndex, source: "MODEL", type, status: "DONE", ...extra });
  }

  /**
   * A tailer over a file in a temp directory, with every render it reports, the rows it actually
   * published, and the promise that says a render has landed. Following is left to the test to
   * start and stop, since when it stops is what these cases are about.
   */
  function harness(file: string) {
    /** Every render call, including the ones that carry nothing. */
    const rendered: string[][] = [];
    /** Only the calls that had rows to publish. */
    const published: string[][] = [];
    const degraded: string[] = [];
    const lost: string[] = [];
    const firstRender = Promise.withResolvers<void>();
    const config: SubagentTranscriptConfig = {
      logUri: pathToFileURL(file).href,
      childConversationId: CHILD,
      parentConversationId: PARENT,
      cwd: CWD,
    };
    const handlers: SubagentTranscriptHandlers = {
      onRender: (_render, changed) => {
        rendered.push(changed.map((item) => item.id));
        if (changed.length > 0) published.push(changed.map((item) => item.id));
        firstRender.resolve();
      },
      onDegrade: (reason) => degraded.push(reason),
      onLost: (reason) => lost.push(reason),
    };
    return {
      transcript: new SubagentTranscript(config, handlers),
      rendered,
      published,
      degraded,
      lost,
      firstRender: firstRender.promise,
    };
  }

  /** A temp directory holding the file a case reads, removed by the case that made it. */
  function tempTranscript(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "antigravity-subagent-"));
    return { dir, file: join(dir, "transcript.jsonl") };
  }

  it("publishes nothing from a read that was under way when following stopped", async () => {
    const { dir, file } = tempTranscript();
    writeFileSync(file, `${line(0, "USER_INPUT", { content: "read the file" })}\n`, "utf8");
    const { transcript, rendered, degraded, lost } = harness(file);

    // The read is under way — it is waiting on the file — when following stops beneath it, which is
    // what a session close, an interrupted turn, or a finished child does. Nothing that read was
    // going to say may reach the consumer afterwards, not even a render that carries nothing.
    const last = transcript.readFinal();
    await Promise.resolve();
    transcript.stop();
    await last;

    expect(rendered).toEqual([]);
    expect(degraded).toEqual([]);
    expect(lost).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads once more when the file was not there for the read already under way", async () => {
    const { dir, file } = tempTranscript();
    const { transcript, published, firstRender } = harness(file);

    // `start`'s own read runs against a file that does not exist yet, and the last read is asked
    // for before that one has finished: it has to wait for it and then look again, rather than
    // skip out and turn the caller's last read into no read at all. Which of the two reads finds
    // the line is a race the file system decides, so this asserts on what was published either
    // way, and not on how many reads it took to publish it.
    transcript.start();
    writeFileSync(file, `${line(0, "USER_INPUT", { content: "read the file" })}\n`, "utf8");
    await transcript.readFinal();

    expect(published).toEqual([[`agy-sub:${CHILD}:0:user`]]);
    await firstRender;
    transcript.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes a system-message transcript without reporting its step types", async () => {
    const { dir, file } = tempTranscript();
    writeFileSync(
      file,
      readFileSync(`${fixturesDir}/15-subagent-system-message.transcript.jsonl`, "utf8"),
      "utf8",
    );
    // The warning this case is about is the one `publish` writes for a step type it does not know.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { transcript, published, degraded, lost, firstRender } = harness(file);
    transcript.start();
    await transcript.readFinal();
    await firstRender;
    transcript.stop();

    expect(published.at(-1)).toEqual([
      `agy-sub:${CHILD}:0:user`,
      `agy-sub:${CHILD}:1:tool:0`,
      `agy-sub:${CHILD}:3:msg`,
    ]);
    // Every step of a 1.2.11 child transcript is known: nothing is reported as unknown, and no
    // line is unreadable either.
    expect(logged).not.toHaveBeenCalled();
    expect(degraded).toEqual([]);
    expect(lost).toEqual([]);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
});
