import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodeUserTurn,
  isInterrupted,
  parseAgyErrorLine,
  parseAgyLine,
  type AgyEvent,
} from "./protocol";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

/**
 * `agy --model does-not-exist` never opens a conversation: it reports one failed result and exits
 * 1 without an init event (fixtures/05-error.ndjson).
 */
const LAUNCH_FAILURE_FIXTURES = ["05-error.ndjson"];

function fixtureNames(): string[] {
  return readdirSync(fixturesDir).filter((name) => name.endsWith(".ndjson"));
}

function loadFixture(name: string): AgyEvent[] {
  const raw = readFileSync(`${fixturesDir}/${name}`, "utf8");
  const events: AgyEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const event = parseAgyLine(line);
    expect(event, `unparsed line in ${name}: ${line.slice(0, 120)}`).not.toBeNull();
    if (event) events.push(event);
  }
  return events;
}

describe("parseAgyLine", () => {
  it("ignores blank lines, decorated output, and malformed JSON", () => {
    expect(parseAgyLine("")).toBeNull();
    expect(parseAgyLine("   ")).toBeNull();
    expect(parseAgyLine("Fetching available models...")).toBeNull();
    expect(parseAgyLine("{not json")).toBeNull();
    expect(parseAgyLine("[1,2,3]")).toBeNull();
    expect(parseAgyLine('"a string"')).toBeNull();
    expect(parseAgyLine('{"no_event_field":true}')).toBeNull();
  });

  it("degrades to an unknown event instead of throwing on a payload it cannot decode", () => {
    expect(parseAgyLine('{"event":"something_new"}')).toEqual({
      kind: "unknown",
      event: "something_new",
    });
    // A known name with an unusable payload must not surface as a typed event.
    expect(parseAgyLine('{"event":"result","result":{"nope":true}}')).toEqual({
      kind: "unknown",
      event: "result",
    });
    expect(parseAgyLine('{"event":"step_update"}')).toEqual({
      kind: "unknown",
      event: "step_update",
    });
  });

  it("rejects an init event without a usable conversation id", () => {
    // An eligibility failure reports an empty id, which would name a transcript file ".jsonl".
    expect(parseAgyLine('{"event":"init","conversation_id":"","init":{"cwd":"/tmp"}}')).toEqual({
      kind: "unknown",
      event: "init",
    });
  });

  it("decodes init with its conversation id and tool list", () => {
    const event = parseAgyLine(
      '{"event":"init","conversation_id":"abc","init":{"cwd":"/tmp","tools":["run_command"],"permission_mode":"always-proceed"}}',
    );
    expect(event).toEqual({
      kind: "init",
      conversationId: "abc",
      cwd: "/tmp",
      tools: ["run_command"],
    });
  });

  it("encodes one user turn as a single NDJSON line with the event envelope", () => {
    const line = encodeUserTurn("hello");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      event: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  });
});

describe("parseAgyErrorLine", () => {
  it("reads the documented fields and keeps the JSON verbatim", () => {
    const line =
      'AGY_ERROR: {"short_error":"model API request failed","status":"UNAVAILABLE","code":"503","retryable":true,"error_id":"e-1234"}';
    expect(parseAgyErrorLine(line)).toEqual({
      status: "UNAVAILABLE",
      short_error: "model API request failed",
      retryable: true,
      raw: line.slice("AGY_ERROR: ".length),
    });
  });

  it("ignores an ordinary stderr line, and keeps a decodable one it does not recognise", () => {
    expect(parseAgyErrorLine("error: invalid model selection")).toBeNull();
    expect(parseAgyErrorLine("AGY_ERROR: not json")).toBeNull();
    expect(parseAgyErrorLine("AGY_ERROR: [1,2]")).toBeNull();
    // Unknown fields survive in `raw`, which is what reaches ProviderError.diagnostic.
    expect(parseAgyErrorLine('AGY_ERROR: {"something_new":"x"}')).toEqual({
      raw: '{"something_new":"x"}',
    });
  });

  it("finds no structured line in the captured failures", () => {
    // The decoder is forward-compatible: agy reports both captured failures (an invalid model, an
    // outage) through a plain `error:` line plus a failed result, never through AGY_ERROR.
    for (const name of ["05-error.stderr", "05-unavailable.stderr"]) {
      const lines = readFileSync(join(fixturesDir, name), "utf8").split("\n");
      expect(lines.filter((line) => parseAgyErrorLine(line) !== null)).toEqual([]);
    }
  });
});

describe("captured agy fixtures", () => {
  it("has fixtures on disk to exercise the decoder", () => {
    expect(fixtureNames().length).toBeGreaterThan(0);
  });

  it.each(fixtureNames())("%s decodes without loss and starts with init", (name) => {
    const events = loadFixture(name);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "unknown")).toBe(false);

    const first = events[0];
    if (LAUNCH_FAILURE_FIXTURES.includes(name)) {
      expect(first?.kind).toBe("result");
      return;
    }
    expect(first?.kind).toBe("init");
    if (first?.kind === "init") {
      expect(first.conversationId).toMatch(/[0-9a-f-]{8,}/);
      expect(first.tools.length).toBeGreaterThan(0);
    }
  });

  it.each(fixtureNames())("%s ends with a terminal result event", (name) => {
    const events = loadFixture(name);
    expect(events.at(-1)?.kind).toBe("result");
  });

  it("carries tool steps with a canonical tool name and parameters", () => {
    const toolSteps = loadFixture("02-tool-calls.ndjson").flatMap((event) =>
      event.kind === "step_update" && event.step.step_type === "tool" ? [event.step] : [],
    );
    expect(toolSteps.length).toBeGreaterThan(0);

    const done = toolSteps.filter((step) => step.state === "DONE");
    expect(done.length).toBeGreaterThan(0);
    expect(done[0]?.tool_name).toBe("run_command");
    expect(done[0]?.tool_info?.parameters).toMatchObject({ CommandLine: expect.any(String) });
    expect(typeof done[0]?.tool_info?.output).toBe("string");
  });

  /**
   * The regression that matters most: text_delta is an incremental chunk, so the deltas for a
   * turn must concatenate back to the turn's reported response. If agy ever switches to
   * snapshots this fails loudly instead of silently duplicating text in Paseo.
   */
  it.each(fixtureNames())("%s streams deltas that rebuild each result response", (name) => {
    const events = loadFixture(name);
    let accumulated = "";
    let turns = 0;

    for (const event of events) {
      if (event.kind === "step_update" && event.step.step_type === "agent_response") {
        accumulated += event.step.text_delta ?? "";
        continue;
      }
      if (event.kind !== "result") continue;

      turns += 1;
      expect(accumulated, `turn ${turns} of ${name}`).toBe(event.result.response);
      accumulated = "";
    }

    expect(turns).toBeGreaterThan(0);
  });

  // 19/19b were recorded with `"queuedMessages": "send-immediately"` (agy 1.2.14), mid-stream and
  // mid-tool: stream-json queues regardless of that TUI setting.
  it.each([
    "04-queued-second-line.ndjson",
    "19-queued-send-immediately.ndjson",
    "19b-queued-send-immediately-mid-tool.ndjson",
  ])("%s reports queued follow-up input as a separate turn, never as a steer", (name) => {
    const events = loadFixture(name);
    const results = events.filter((event) => event.kind === "result");
    expect(results.length).toBe(2);
    expect(results.every((event) => event.kind === "result" && !isInterrupted(event.result))).toBe(true);

    // The first turn runs to completion before the second input begins, which is why the
    // provider does not advertise prompt.steer.
    const firstResultIndex = events.findIndex((event) => event.kind === "result");
    const secondUserInputIndex = events.findIndex(
      (event, index) =>
        index > firstResultIndex &&
        event.kind === "step_update" &&
        event.step.step_type === "user_input",
    );
    expect(secondUserInputIndex).toBeGreaterThan(firstResultIndex);
  });

  it("recognises an interrupted turn as a cancellation rather than a failure", () => {
    // Captured from a real SIGINT: `error: interrupted` on stderr, then this result, then exit 1.
    expect(
      isInterrupted({ status: "ERROR", error: "interrupted", response: "", num_turns: 0 }),
    ).toBe(true);
    expect(
      isInterrupted({ status: "ERROR", error: "Eligibility check failed", num_turns: 0 }),
    ).toBe(false);
    expect(isInterrupted({ status: "SUCCESS", response: "ok" })).toBe(false);
  });

  it("decodes the two lines one invoke_subagent call is reported through", () => {
    const steps = loadFixture("12-subagents.ndjson").flatMap((event) =>
      event.kind === "step_update" ? [event.step] : [],
    );
    const tool = steps.find(
      (step) => step.step_type === "tool" && step.tool_name === "invoke_subagent",
    );
    const subagent = steps.find((step) => step.step_type === "subagent");

    // The same step index, reported twice: first as the tool call, then as what it spawned.
    expect(tool?.state).toBe("ACTIVE");
    expect(subagent?.state).toBe("DONE");
    expect(subagent?.step_index).toBe(tool?.step_index);

    const parameters = tool?.tool_info?.parameters as
      | { Subagents?: Array<{ Role?: string; TypeName?: string; Prompt?: string }> }
      | undefined;
    expect(parameters?.Subagents?.map((entry) => [entry.TypeName, entry.Role])).toEqual([
      ["research", "Researcher A"],
      ["research", "Researcher B"],
    ]);

    const children = subagent?.subagent_info?.subagents ?? [];
    expect(children.map((child) => child.role)).toEqual(["Researcher A", "Researcher B"]);
    expect(children[0]).toMatchObject({
      type_name: "research",
      initial_prompt: "Please read the file /Users/dev/agy-subagent-probe2/a.txt and report its exact contents.",
      conversation_id: "15363ad9-3485-4249-aee7-a7605879f405",
      workspace_uris: ["file:///Users/dev/agy-subagent-probe2"],
    });
    expect(children[0]?.log_uri).toMatch(
      /^file:\/\/.*15363ad9-3485-4249-aee7-a7605879f405\/\.system_generated\/logs\/transcript\.jsonl$/,
    );
  });

  it("drops a subagent payload it cannot decode without losing the step", () => {
    // The row the tool line already published is worth more than the children of a shape agy
    // cannot have meant, so a bad payload costs the payload and nothing else.
    const event = parseAgyLine(
      '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"subagent","subagent_info":{"subagents":"nope"}}}',
    );
    expect(event?.kind).toBe("step_update");
    if (event?.kind !== "step_update") return;
    expect(event.step.subagent_info).toBeUndefined();
    expect(event.step.step_type).toBe("subagent");

    const odd = parseAgyLine(
      '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"subagent","subagent_info":{"something_new":1}}}',
    );
    expect(odd?.kind).toBe("step_update");
    if (odd?.kind !== "step_update") return;
    expect(odd.step.subagent_info).toEqual({ something_new: 1 });
  });
});
