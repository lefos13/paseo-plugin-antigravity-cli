import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderBackfill } from "./backfill";
import { parseTranscriptLines } from "./subagents";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const CWD = "/tmp/agy-question-probe";

function replay(name: string) {
  const parsed = parseTranscriptLines(readFileSync(`${fixturesDir}/${name}`, "utf8"));
  expect(parsed.malformed).toBe(0);
  return renderBackfill(
    parsed.entries,
    {
      message: (stepIndex) => `msg:${stepIndex}`,
      tool: (stepIndex) => `tool:${stepIndex}`,
    },
    CWD,
  );
}

describe("renderBackfill", () => {
  it("fails the call whose GENERIC result carries agy's error", () => {
    // fixtures/17, captured from a real agy run: the view_file call at step 3 had its result
    // written as a GENERIC line in ERROR, with the reason beside the content the call never
    // produced.
    const render = replay("17-ask-question.transcript.jsonl");
    const rows = new Map(render.rows.map((row) => [row.stepIndex, row.item]));

    expect(rows.get(4)).toMatchObject({
      type: "tool_call",
      id: "tool:4",
      callId: "tool:4",
      name: "view_file",
      status: "failed",
      error: {
        message:
          "declaring permissions: cortex tool view_file: convert tool call for permissions: " +
          "model output error: invalid tool call error (invalid_args) failed to read file: " +
          "stat /tmp/agy-question-probe/README.md: no such file or directory",
      },
    });
    // Its detail still maps the call as it did, including the content the failed result wrote.
    expect(rows.get(4)).toMatchObject({
      detail: { type: "read", filePath: "/tmp/agy-question-probe/README.md" },
    });
  });

  it("leaves the calls without an error exactly as they were", () => {
    const render = replay("17-ask-question.transcript.jsonl");
    const rows = new Map(render.rows.map((row) => [row.stepIndex, row.item]));

    // The calls before and after the failure still completed, with no error of their own.
    for (const stepIndex of [2, 6, 8, 10]) {
      expect(rows.get(stepIndex)).toMatchObject({ status: "completed", error: null });
    }
  });

  it("keeps a call without a result running, and one with a blank error completed", () => {
    const render = renderBackfill(
      [
        {
          stepIndex: 0,
          type: "PLANNER_RESPONSE",
          toolCalls: [{ name: "view_file", args: { AbsolutePath: '"/tmp/a.txt"' } }],
        },
        { stepIndex: 1, type: "GENERIC", content: "contents", toolCalls: [] },
        {
          stepIndex: 2,
          type: "PLANNER_RESPONSE",
          toolCalls: [{ name: "view_file", args: { AbsolutePath: '"/tmp/b.txt"' } }],
        },
        { stepIndex: 3, type: "GENERIC", error: "  ", content: "contents", toolCalls: [] },
        {
          stepIndex: 4,
          type: "PLANNER_RESPONSE",
          toolCalls: [{ name: "view_file", args: { AbsolutePath: '"/tmp/c.txt"' } }],
        },
      ],
      { message: (stepIndex) => `msg:${stepIndex}`, tool: (stepIndex) => `tool:${stepIndex}` },
      CWD,
    );
    const rows = new Map(render.rows.map((row) => [row.stepIndex, row.item]));

    expect(rows.get(1)).toMatchObject({ status: "completed", error: null });
    // A blank reason is no failure: the GENERIC line still completed the call it answers.
    expect(rows.get(3)).toMatchObject({ status: "completed", error: null });
    expect(rows.get(5)).toMatchObject({ status: "running", error: null });
  });

  it("leaves a non-zero command completed and an interrupted call running, from the 1.4.8 captures", () => {
    // 29c: `ls` exited 1, and agy wrote the result as a plain GENERIC line, so the call completed.
    const command = new Map(
      replay("29c-failed-command.transcript.jsonl").rows.map((row) => [row.stepIndex, row.item]),
    );
    expect(command.get(2)).toMatchObject({
      type: "tool_call",
      name: "run_command",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "ls /nonexistent-dir-xyz" },
    });
    expect(
      [...command.values()].filter((item) => item.type === "tool_call" && item.status === "failed"),
    ).toEqual([]);

    // 29b: SIGINT ended the turn before the call's result was written, so nothing settles it.
    const interrupted = new Map(
      replay("29b-interrupted-tool.transcript.jsonl").rows.map((row) => [row.stepIndex, row.item]),
    );
    expect(interrupted.get(2)).toMatchObject({
      type: "tool_call",
      name: "run_command",
      status: "running",
      error: null,
    });
  });
});
