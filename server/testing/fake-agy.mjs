#!/usr/bin/env node
/**
 * Stands in for the Antigravity CLI in tests. It speaks the captured stream-json protocol
 * (see server/protocol.ts and fixtures/) and can be told which scenario to play through env vars.
 *
 *   FAKE_ARGV_FILE       when set, the received argv is written here so tests can assert flags
 *   FAKE_ARGV_LOG        when set, every launch appends its argv here, one JSON array per line
 *   FAKE_ENV_FILE        when set, the launch's own `HOME` is written here as JSON, which is how a
 *                        test tells an account's shadow home from the real one (or its absence)
 *   FAKE_SCENARIO        text (default) | tool | edit | edit-applied | queued | interrupt | error
 *                        | fail | tool-hang | stdin-closed | schema | schema-invalid | subagent
 *                        | ask-question
 *   FAKE_SUBAGENT_COUNT       children the `subagent` scenario spawns (default 1)
 *   FAKE_SUBAGENT_TRANSCRIPT  what the `subagent` scenario writes for each child: valid (default),
 *                             malformed (unreadable lines only), missing (no file at all), or
 *                             unknown-type (valid, plus one step of a type nothing knows)
 *   FAKE_SUBAGENT_GATE        file the `subagent` scenario waits for before the parent's final
 *                             answer, so a test can watch a child stream while its turn runs
 *   FAKE_QUESTIONS       JSON array the `ask-question` scenario asks, in agy's own shape
 *                        ([{question, options, is_multi_select}]); default one Red/Blue question
 *   FAKE_QUESTION_TOOL   tool the `ask-question` planner step calls (default ask_question); any
 *                        other name plays an ordinary tool result on the same `unknown` step
 *   FAKE_QUESTION_GATE   file the `ask-question` scenario waits for (up to 10 s) after the skipped
 *                        question, which is the window a consumer has to interrupt it; unset, it
 *                        carries on at once, as agy does when nobody intervenes
 *   FAKE_QUESTION_EFFECT file the `ask-question` scenario writes "User Skipped" into when it carries
 *                        on, the way the captured model wrote its skip into color.txt
 *   FAKE_SCHEMA_OUTPUT   JSON the `schema` scenario returns as structured_output
 *   FAKE_SCHEMA_GATE     file the `schema` scenario waits for before answering, so a test can act
 *                        while that turn is still running
 *   FAKE_SCHEMA_ERROR    text of a failed result the `schema` scenario reports instead of SUCCESS
 *   FAKE_SCHEMA_STICKY   "1" makes even a flagless process report that structured_output, which
 *                        is what agy does on a conversation that has used a schema
 *   FAKE_EDIT_FILE       file an `edit` turn rewrites (default <cwd>/hello.txt)
 *   FAKE_EDIT_TOOL       tool an `edit` turn reports (default replace_file_content)
 *   FAKE_EDIT_AFTER      content the edit writes (default "bye world\n")
 *   FAKE_EDIT_GATE       file the rewrite waits for, so the test decides when the edit lands
 *   FAKE_EDIT_SKIP_WRITE "1" reports the edit without writing anything
 *   FAKE_CONVERSATION_ID conversation id reported by the init event
 *   FAKE_STDERR_LINE     diagnostic written by the `fail` scenario
 *   FAKE_RESULT_ERROR    text of the failed result in the `error` scenario and in `tool-hang`
 *                        with FAKE_TOOL_END=error
 *   FAKE_TOOL_END        how `tool-hang` ends the turn: interrupt (default) | error | die
 *   FAKE_MODELS_OK       "1" makes `agy models` succeed, anything else makes it fail
 *   FAKE_MODELS_LOG      when set, every `agy models` run appends a line here
 *   FAKE_QUOTA           the answer to `-p /usage --output-format json` (server/quota.ts):
 *                        ok (default) | signed-out | error | agent-turn | garbage
 *   FAKE_QUOTA_LOG       when set, every `/usage` run appends its argv, HOME and cwd here
 *   FAKE_RESULT_INPUT_TOKENS  input_tokens of the terminal result (default 15466)
 *   FAKE_STEP_INPUT_TOKENS    input_tokens of an agent_response step (default: the result's)
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);

if (process.env.FAKE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv), "utf8");
}

// Every launch, in order: a restart test needs to see the flags of each process, not just the last.
if (process.env.FAKE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`, "utf8");
}

// Like a real `agy`, this process resolves `$HOME/.gemini` — so a test can assert which home it was
// launched under (and that no HOME was invented where none was configured).
if (process.env.FAKE_ENV_FILE) {
  writeFileSync(process.env.FAKE_ENV_FILE, JSON.stringify({ HOME: process.env.HOME ?? null }), "utf8");
}

/** The schema file `--json-schema` points at, when this process was launched with one. */
const schemaIndex = argv.indexOf("--json-schema");
const schemaPath = schemaIndex === -1 ? null : argv[schemaIndex + 1];

if (argv[0] === "models") {
  if (process.env.FAKE_MODELS_LOG) {
    appendFileSync(process.env.FAKE_MODELS_LOG, "models\n", "utf8");
  }
  if (process.env.FAKE_MODELS_OK === "1") {
    // Copied verbatim from `agy models` on Antigravity CLI 1.2.9, plus one model the real CLI
    // does not have so a test can tell a discovered row from a bundled one.
    process.stdout.write("Fetching available models...\n");
    process.stdout.write("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
    process.stdout.write("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n");
    process.stdout.write("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n");
    process.stdout.write("gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n");
    process.stdout.write("gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n");
    process.stdout.write("gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n");
    process.stdout.write("gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n");
    process.stdout.write("gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\n");
    process.stdout.write("gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n");
    process.stdout.write("gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n");
    process.stdout.write("gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n");
    process.stdout.write("claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
    process.stdout.write("claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n");
    process.stdout.write("gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n");
    process.stdout.write("fake-model-x\tFake Model X\n");
    process.exit(0);
  }
  process.stderr.write("error: could not list models\n");
  process.exit(1);
}

/** A read-only command turn spends nothing, so its token counters are all zero. */
const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
};

/**
 * The quota read: `agy -p /usage --output-format json`. It is its own short-lived process, never
 * the stream-json session (see server/quota.ts), so it is answered here and the process exits
 * without reading stdin. Output is flushed before exiting: a `process.exit()` right after a write to
 * a pipe truncates it.
 */
if (argv[0] === "-p" && argv[1] === "/usage") {
  if (process.env.FAKE_QUOTA_LOG) {
    appendFileSync(
      process.env.FAKE_QUOTA_LOG,
      `${JSON.stringify({ argv, HOME: process.env.HOME ?? null, cwd: process.cwd() })}\n`,
      "utf8",
    );
  }
  // A synchronous write, so the payload is in the pipe before the process is gone: `execFile` would
  // otherwise race an async stdout write against `process.exit`.
  const emit = (fd, text, code) => {
    writeSync(fd, text);
    process.exit(code);
  };
  const json = (payload) => emit(1, `${JSON.stringify(payload)}\n`, 0);

  switch (process.env.FAKE_QUOTA ?? "ok") {
    case "signed-out":
      // A logged-out CLI refuses to read quota. Which channel it uses is not something the plugin
      // relies on, so the fixture puts the line on stderr and exits non-zero.
      emit(2, "error: You are not logged into Antigravity. Please sign in.\n", 1);
      break;
    case "error":
      // `status: ERROR` carrying `agy`'s own message and no command payload: the shape a
      // service-side quota failure has.
      json({
        ...quotaEnvelope(),
        status: "ERROR",
        response: "",
        error: "no quota summary is available for this account",
        duration_seconds: 0.4,
      });
      break;
    case "agent-turn":
      // What `/usage` becomes when slash expansion is disabled: a real agent turn that spends quota.
      json({
        ...quotaEnvelope(),
        response: "Antigravity counts your usage against a weekly and a five hour limit.\n",
        duration_seconds: 12.5,
        num_turns: 1,
        usage: { ...zeroUsage, input_tokens: 15466, output_tokens: 27, total_tokens: 15518 },
      });
      break;
    case "garbage":
      emit(1, "not json at all\n", 0);
      break;
    default:
      json(quotaPayload());
  }
  // `emit` exits the process, so nothing below it runs.
}

/** The top-level fields every `/usage` result has, without the command payload. */
function quotaEnvelope() {
  return {
    conversation_id: "99999999-0000-4111-8222-333333333333",
    status: "SUCCESS",
    response: [
      "Gemini Models\tWeekly Limit Remaining\t45%\t2026-09-30T09:43:54Z",
      "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-09-27T16:10:09Z",
      "Claude and GPT models\tWeekly Limit Remaining\t87%\t2026-09-30T14:42:32Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-27T16:10:09Z",
      "",
    ].join("\n"),
    duration_seconds: 4.2,
    num_turns: 0,
    usage: zeroUsage,
  };
}

/**
 * Copied from `agy -p '/usage' --output-format json` on Antigravity CLI 1.2.12
 * (`tasks/quota-research/agy-local.md` §1.3). One bucket's `remaining_fraction` is deliberately
 * absent, so a test can assert that the plugin drops it instead of showing it as 0 %.
 */
function quotaPayload() {
  return {
    ...quotaEnvelope(),
    command: {
      name: "usage",
      data: {
        description: "Model quota usage",
        groups: [
          {
            name: "Gemini Models",
            description: "Gemini quota",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit Remaining",
                description: "it will fully refresh in 2 days, 22 hours.",
                window: "weekly",
                remaining_fraction: 0.4486817717552185,
                reset_time: "2026-09-30T09:43:54Z",
              },
              {
                id: "gemini-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remaining_fraction: 1,
                reset_time: "2026-09-27T16:10:09Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            description: "Third party model quota",
            buckets: [
              {
                id: "3p-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remaining_fraction: 0.8659847974777222,
                reset_time: "2026-09-30T14:42:32Z",
              },
              {
                id: "3p-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                reset_time: "2026-09-27T16:10:09Z",
              },
            ],
          },
        ],
      },
    },
  };
}

const conversationId = process.env.FAKE_CONVERSATION_ID ?? "11111111-2222-3333-4444-555555555555";
const scenario = process.env.FAKE_SCENARIO ?? "text";

/** Mirrors a captured 503: agy fails the turn and quotes the service error to the user. */
const defaultResultError = "Eligibility check failed: the service is currently unavailable.";

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

/**
 * Sends a terminal result. Antigravity keeps a schema with the *conversation*: a process started
 * without `--json-schema` still reports that conversation's last structured_output, which is why
 * the knob applies to results the schema scenario did not build itself (probed 2026-09-23).
 */
const sendResult = (result) => {
  const sticky =
    process.env.FAKE_SCHEMA_STICKY === "1" && result.structured_output === undefined
      ? JSON.parse(process.env.FAKE_SCHEMA_OUTPUT ?? '{"color":"blue","count":8}')
      : undefined;
  send({ event: "result", result: sticky === undefined ? result : { ...result, structured_output: sticky } });
};

const usage = {
  input_tokens: Number(process.env.FAKE_RESULT_INPUT_TOKENS ?? 15466),
  output_tokens: 27,
  thinking_tokens: 25,
  cache_read_tokens: 0,
  total_tokens: 15518,
};

/**
 * The result totals every step of the turn, while a step reports what the model held in its
 * context window, which is why the two are configurable apart (captured: 31074 = 15388 + 15686).
 */
const stepUsage = {
  ...usage,
  input_tokens: Number(process.env.FAKE_STEP_INPUT_TOKENS ?? usage.input_tokens),
};

let step = 0;
let turns = 0;

/**
 * Holds a scenario until the test lets it continue. Polling a file is the only channel between a
 * test and this process; there is no timing guess and no sleep to speak of.
 */
async function waitForGate(variable = "FAKE_EDIT_GATE") {
  const gate = process.env[variable];
  if (!gate) return;
  const deadline = Date.now() + 10_000;
  while (!existsSync(gate) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// The queued scenario holds turn 1's answer until the second line arrives.
let heldAnswer = null;

/**
 * One child of the `subagent` scenario. Ids are deterministic, so a test can find a child's own
 * transcript from the id alone as well as from the `log_uri` the parent's stream reports.
 */
function subagentChildren(count) {
  const children = [];
  for (let index = 0; index < count; index += 1) {
    const conversationId = `aaaaaaaa-0000-4000-8000-00000000000${index}`;
    children.push({
      conversationId,
      role: `Researcher ${String.fromCharCode(65 + index)}`,
      typeName: "research",
      file: `${process.cwd()}/subagent-${index}.txt`,
      // Where agy keeps a child conversation's own trajectory, which is what `log_uri` names.
      path: join(
        homedir(),
        ".gemini",
        "antigravity-cli",
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ),
    });
  }
  return children;
}

/**
 * The lines one child writes for itself, mirroring a captured child (fixtures/12-subagent-*): a
 * prompt in agy's `<USER_REQUEST>` envelope, a `view_file` call with its result on the next line, a
 * `send_message` reporting to the parent, and a last word of text with no call — which is the step
 * that says the child is done. Every argument value is a JSON-encoded string, as agy writes them.
 */
function childTranscriptLines(child, parentConversationId) {
  const prompt = `Please read the file ${child.file} and report its exact contents.`;
  const name = basename(child.file);
  const report = `The file \`${child.file}\` contains:\n\n\`\`\`\nalpha\n\`\`\``;
  const step = (stepIndex, type, extra) =>
    JSON.stringify({
      step_index: stepIndex,
      source: "MODEL",
      type,
      status: "DONE",
      created_at: "2026-09-23T19:49:34Z",
      ...extra,
    });

  const head = [
    step(0, "USER_INPUT", {
      source: "USER_EXPLICIT",
      content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-23T22:49:34+03:00.\n</ADDITIONAL_METADATA>`,
    }),
    step(2, "GENERIC", { content: `File Path: \`file://${child.file}\`\n1: alpha\n2: \n` }),
    step(1, "PLANNER_RESPONSE", {
      tool_calls: [
        {
          name: "view_file",
          args: {
            AbsolutePath: JSON.stringify(child.file),
            toolAction: JSON.stringify(`Reading ${name}`),
            toolSummary: JSON.stringify(`Read ${name}`),
          },
        },
      ],
    }),
    step(3, "PLANNER_RESPONSE", {
      tool_calls: [
        {
          name: "send_message",
          args: {
            Message: JSON.stringify(report),
            Recipient: JSON.stringify(parentConversationId),
            toolAction: '"Sending report to parent"',
            toolSummary: JSON.stringify(`Report ${name}`),
          },
        },
      ],
    }),
    step(4, "GENERIC", { content: `Message sent to "${parentConversationId}".` }),
  ];
  // Complete lines that are not steps: nothing here can be followed, whatever else is configured.
  if (process.env.FAKE_SUBAGENT_TRANSCRIPT === "malformed") {
    return { head: ["not json\n", '{"no_step_index":true}\n'], tail: [] };
  }
  // A child that never writes anything at all: its transcript is never created.
  if (process.env.FAKE_SUBAGENT_TRANSCRIPT === "missing") {
    return { head: [], tail: [] };
  }
  // The child's own last word, written after the head so a gate can hold it back.
  const lastWord = `I have read ${child.file} and reported its contents back to the parent agent.`;
  const tail =
    process.env.FAKE_SUBAGENT_TRANSCRIPT === "unknown-type"
      ? // A step type nothing knows, written *before* the last word: the renderer reads "done" from
        // the highest step, and that must not depend on a line it does not understand.
        [step(5, "FOO", { content: "a step type nothing knows" }), step(6, "PLANNER_RESPONSE", { content: lastWord })]
      : [step(5, "PLANNER_RESPONSE", { content: lastWord })];
  return { head, tail };
}

/** Appends lines and yields, so a reader can see the file grow rather than only its end state. */
async function writeChildLines(path, lines) {
  if (lines.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const stepEvent = (stepIndex, state, stepType, extra = {}) => ({
  event: "step_update",
  step_update: {
    conversation_id: conversationId,
    step_index: stepIndex,
    state,
    step_type: stepType,
    ...extra,
  },
});

/** The `result` payload of a turn, as `sendResult` expects it. */
const turnResult = (numTurns, response, status = "SUCCESS", error) => ({
  conversation_id: conversationId,
  status,
  response,
  ...(error ? { error } : {}),
  num_turns: numTurns,
  usage,
});

/**
 * Turn 1 streams half an answer and then waits for the queued line before finishing, the order agy
 * uses when a prompt arrives while it is still running (see fixtures/04-queued-second-line.ndjson).
 */
function playQueued(text) {
  const response = `echo:${text}`;
  const middle = Math.max(1, Math.floor(response.length / 2));

  if (heldAnswer === null) {
    send(stepEvent(step, "DONE", "user_input"));
    step += 1;
    const textStep = step;
    step += 1;
    send(stepEvent(textStep, "ACTIVE", "agent_response", { text_delta: response.slice(0, middle) }));
    heldAnswer = { textStep, response, offset: middle };
    return;
  }

  const held = heldAnswer;
  heldAnswer = null;
  // The held turn's remaining text and its result both precede the queued turn.
  send(
    stepEvent(held.textStep, "DONE", "agent_response", {
      text_delta: `${held.response.slice(held.offset)}\n`,
      usage: stepUsage,
    }),
  );
  sendResult(turnResult(1, `${held.response}\n`));

  send(stepEvent(step, "DONE", "user_input"));
  step += 1;
  const textStep = step;
  step += 1;
  send(stepEvent(textStep, "ACTIVE", "agent_response", { text_delta: response.slice(0, middle) }));
  send(
    stepEvent(textStep, "DONE", "agent_response", {
      text_delta: `${response.slice(middle)}\n`,
      usage: stepUsage,
    }),
  );
  sendResult(turnResult(2, `${response}\n`));
}

/**
 * The first turn of a fresh `ask-question` process plays fixtures/17-ask-question.*: the planner
 * step that calls ask_question, then the call itself as an `unknown` step, with agy's own
 * transcript lines written before either reaches stdout. agy answers the call with "User Skipped"
 * and the turn carries on unless SIGINT arrives while the gate holds it.
 */
let questionAsked = false;
/** A line that arrives while the question turn is held is queued by agy, so it gets no answer here. */
let questionHolding = false;

function questionTranscriptPath() {
  return join(homedir(), ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

async function playQuestion(text) {
  questionAsked = true;
  questionHolding = true;
  const toolName = process.env.FAKE_QUESTION_TOOL ?? "ask_question";
  const questions = JSON.parse(
    process.env.FAKE_QUESTIONS ?? '[{"is_multi_select":false,"options":["Red","Blue"],"question":"Which colour do you prefer?"}]',
  );
  const planner = step;
  const call = planner + 1;
  step += 2;
  const encode = (value) => JSON.stringify(value);
  const args =
    toolName === "ask_question"
      ? { questions: encode(questions), toolAction: encode("Asking colour preference"), toolSummary: encode("Colour preference question") }
      : { toolAction: encode("Listing tasks"), toolSummary: encode("Task list") };
  const skipped = questions.map((_, index) => `A${index + 1}: User Skipped`).join("\n");
  const stamp = "Created At: 2026-09-28T13:19:40+03:00\nCompleted At: 2026-09-28T13:19:40+03:00\n";
  await writeChildLines(questionTranscriptPath(), [
    encode({ step_index: planner - 1, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }),
    encode({ step_index: planner, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: toolName, args }] }),
    encode({ step_index: call, source: "MODEL", type: "GENERIC", status: "DONE", content: toolName === "ask_question" ? `${stamp}${skipped}` : `${stamp}No tasks.` }),
  ]);
  send(stepEvent(planner, "DONE", "agent_response", { duration_seconds: 3.3, usage: stepUsage }));
  send(stepEvent(call, "DONE", "unknown", { duration_seconds: 0.0157 }));

  await waitForGate("FAKE_QUESTION_GATE");
  questionHolding = false;
  if (process.env.FAKE_QUESTION_EFFECT) writeFileSync(process.env.FAKE_QUESTION_EFFECT, "User Skipped\n", "utf8");
  const answer = toolName === "ask_question" ? "You skipped the question (User Skipped), so I picked Red." : "There are no tasks.";
  const answerStep = step;
  step += 1;
  send(stepEvent(answerStep, "DONE", "agent_response", { text_delta: answer, duration_seconds: 0.1, usage: stepUsage }));
  sendResult(turnResult(turns, `${answer}\n`));
}

// Registered before any output is written, so a consumer that has seen `init` can rely on
// SIGINT being handled rather than terminating the process by default.
const toolEnding = process.env.FAKE_TOOL_END ?? "interrupt";
if (
  scenario === "interrupt" ||
  scenario === "subagent" ||
  scenario === "ask-question" ||
  (scenario === "tool-hang" && toolEnding === "interrupt")
) {
  // Captured behaviour: SIGINT prints `error: interrupted` on stderr, emits a failed result
  // carrying the same marker, then exits with code 1.
  process.on("SIGINT", () => {
    process.stderr.write("error: interrupted\n");
    // Exit from the write callback so the result is flushed; process.exit() would truncate it.
    process.stdout.write(
      `${JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "ERROR",
          response: "",
          error: "interrupted",
          duration_seconds: 0,
          num_turns: turns,
          usage,
        },
      })}\n`,
      () => process.exit(1),
    );
  });
}

// A CLI whose stdin has already closed reads nothing more: `stdin-closed` closes the pipe before
// reporting init, so a turn written afterwards hits a dead pipe, and a listening socket keeps the
// process up.
const stdinGone = scenario === "stdin-closed";
if (stdinGone) {
  closeSync(0);
  createServer().listen(0);
}

// A CLI that rejects its `--json-schema` never starts a conversation: agy prints the reason and
// exits 1 with no stdout at all, which is why this scenario emits no init event.
const schemaRejected = scenario === "schema-invalid";

if (!schemaRejected) {
  send({
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: process.cwd(),
      tools: ["run_command", "view_file"],
      permission_mode: "always-proceed",
    },
  });
}

const input = stdinGone ? new PassThrough() : process.stdin;
readline.createInterface({ input }).on("line", async (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.event !== "user") return;

  const content = message.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : "";

  if (process.env.FAKE_PROMPT_FILE) {
    appendFileSync(process.env.FAKE_PROMPT_FILE, `${JSON.stringify(text)}\n`, "utf8");
  }

  if (scenario === "ask-question" && questionHolding) return;

  if (scenario === "fail") {
    // Mirrors a rejected --model: agy writes to stderr and exits without a result event.
    process.stderr.write(
      `${process.env.FAKE_STDERR_LINE ?? "error: invalid model selection: model nope is not recognized"}\n`,
    );
    process.exit(1);
  }

  if (schemaRejected) {
    // agy 1.2.9 exits 1 with no stdout when the schema file cannot be read, so the turn must be
    // failed from the exit path instead of waiting for an answer that is never coming.
    process.stderr.write("Error: invalid --json-schema: failed to parse schema file\n");
    process.exit(1);
  }

  if (scenario === "queued") {
    playQueued(text);
    return;
  }

  turns += 1;
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "DONE",
      step_type: "user_input",
    },
  });
  step += 1;

  // Stay silent so the turn stays running until the test interrupts it.
  if (scenario === "interrupt") return;

  // A relaunch that resumes the conversation answers the user's reply as plain text, and so does
  // every later turn of the process that asked.
  if (scenario === "ask-question" && !questionAsked && !argv.includes("--conversation")) {
    await playQuestion(text);
    return;
  }

  if (scenario === "subagent") {
    const requested = Number.parseInt(process.env.FAKE_SUBAGENT_COUNT ?? "1", 10);
    const count = Number.isFinite(requested) && requested > 0 ? requested : 1;
    const children = subagentChildren(count);
    const prompts = new Map(
      children.map((child) => [
        child.conversationId,
        `Please read the file ${child.file} and report its exact contents.`,
      ]),
    );

    // Captured order: the tool line reports the call and the children it asked for, then the same
    // step arrives again as the subagent line that names the conversations they run in.
    const callStep = step;
    step += 1;
    send(
      stepEvent(callStep, "ACTIVE", "tool", {
        tool_name: "invoke_subagent",
        tool_info: {
          name: "invoke_subagent",
          parameters: {
            Subagents: children.map((child) => ({
              Model: "inherit",
              Prompt: prompts.get(child.conversationId),
              Role: child.role,
              TypeName: child.typeName,
            })),
          },
        },
      }),
    );
    send(
      stepEvent(callStep, "DONE", "subagent", {
        tool_name: "invoke_subagent",
        duration_seconds: 0.048852,
        subagent_info: {
          subagents: children.map((child) => ({
            type_name: child.typeName,
            role: child.role,
            initial_prompt: prompts.get(child.conversationId),
            conversation_id: child.conversationId,
            log_uri: pathToFileURL(child.path).href,
            workspace_uris: [pathToFileURL(process.cwd()).href],
          })),
        },
      }),
    );

    // The parent keeps talking while its children work, exactly as the captured turn did.
    const narration = "I have dispatched the research subagents to read their files.";
    send(stepEvent(step, "ACTIVE", "agent_response", { text_delta: narration }));
    send(stepEvent(step, "DONE", "agent_response", { text_delta: "\n", usage: stepUsage }));
    step += 1;

    const transcripts = children.map((child) => ({
      child,
      lines: childTranscriptLines(child, conversationId),
    }));
    for (const { child, lines } of transcripts) {
      // A child writes in bursts and not always in step order (step 2 before step 1 was captured),
      // so the head is written in two parts with the file left mid-stream.
      await writeChildLines(child.path, lines.head.slice(0, 2));
      await writeChildLines(child.path, lines.head.slice(2));
    }
    // Everything above is written before the parent's answer, so a test that opens the gate can
    // watch a child report while the parent's own turn is still running.
    await waitForGate("FAKE_SUBAGENT_GATE");

    for (const { child, lines } of transcripts) {
      await writeChildLines(child.path, lines.tail);
    }
    // One system message per child, which is how agy tells the parent a child reported; it carries
    // nothing that says which child, and it arrives long after the child's own transcript has.
    for (let index = 0; index < children.length; index += 1) {
      send(stepEvent(step, "DONE", "system_message", { duration_seconds: 0.000249 }));
      step += 1;
    }

    const answer = `Here are the contents reported by each subagent:\n`;
    send(stepEvent(step, "ACTIVE", "agent_response", { text_delta: answer }));
    send(stepEvent(step, "DONE", "agent_response", { text_delta: "", usage: stepUsage }));
    step += 1;
    sendResult(turnResult(turns, `${narration}\n${answer}`));
    return;
  }

  if (scenario === "tool-hang") {
    // The tool stays ACTIVE: the turn only ends when the test interrupts it, agy reports an
    // error, or the process dies.
    const toolStep = step;
    step += 1;
    send(
      stepEvent(toolStep, "ACTIVE", "tool", {
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "sleep 30" } },
      }),
    );
    if (toolEnding === "error") {
      sendResult(turnResult(turns, "", "ERROR", process.env.FAKE_RESULT_ERROR ?? defaultResultError));
    } else if (toolEnding === "die") {
      process.stderr.write("error: the Antigravity service closed the connection\n");
      process.exit(1);
    }
    return;
  }

  if (scenario === "background") {
    // A command agy moved to the background (captured with agy 1.2.10 on a `npm run demo` dev
    // server): the stream stops at that tool's ACTIVE line while the conversation carries on and
    // finishes in its own transcript. Everything after it — and the result — is held until the
    // task ends, which here is when the test writes FAKE_BACKGROUND_GATE.
    const first = step;
    step += 5;
    const command = { CommandLine: "npm start" };
    send(stepEvent(first, "DONE", "agent_response", { text_delta: "Starting the server." }));
    send(stepEvent(first + 1, "ACTIVE", "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: command } }));

    const encode = (value) => JSON.stringify(value);
    const transcript = [
      { step_index: first - 1, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` },
      { step_index: first, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Starting the server.", tool_calls: [{ name: "run_command", args: { CommandLine: encode("npm start"), toolSummary: encode("Start server") } }] },
      { step_index: first + 1, source: "MODEL", type: "GENERIC", status: "DONE", content: "Tool is running as a background task with task id: task-1" },
      { step_index: first + 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command", args: { CommandLine: encode("curl -s localhost:4719/health") } }] },
      { step_index: first + 3, source: "MODEL", type: "GENERIC", status: "DONE", content: "The command exited with code 0.\nOutput:\nok" },
      { step_index: first + 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: `The server is running (${text}).` },
    ];
    const path = join(homedir(), ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
    await writeChildLines(path, transcript.map((line) => JSON.stringify(line)));

    await waitForGate("FAKE_BACKGROUND_GATE");
    send(stepEvent(first + 1, "DONE", "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: command, output: "started" } }));
    send(stepEvent(first + 2, "DONE", "agent_response", {}));
    send(stepEvent(first + 3, "ACTIVE", "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "curl -s localhost:4719/health" } } }));
    send(stepEvent(first + 3, "DONE", "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "curl -s localhost:4719/health" }, output: "ok" } }));
    send(stepEvent(first + 4, "DONE", "agent_response", { text_delta: `The server is running (${text}).` }));
    sendResult(turnResult(turns, `The server is running (${text}).`));
    return;
  }

  if (scenario === "error") {
    sendResult({
      conversation_id: conversationId,
      status: "ERROR",
      response: "",
      error: process.env.FAKE_RESULT_ERROR ?? defaultResultError,
      duration_seconds: 0,
      num_turns: turns,
      usage,
    });
    return;
  }

  if (scenario === "schema" && schemaPath !== null) {
    // A structured turn as captured in fixtures/10-schema.ndjson: the *streamed* text is the answer
    // with the CLI's toolAction/toolSummary keys added, `response` repeats it, and the decoded
    // answer is in `structured_output`. Reading the schema file also proves the provider wrote it.
    const answer = JSON.parse(process.env.FAKE_SCHEMA_OUTPUT ?? '{"color":"blue","count":8}');
    let schema;
    try {
      schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    } catch (error) {
      sendResult(turnResult(turns, "", "ERROR", `invalid --json-schema: ${error.message}`));
      return;
    }
    const streamed = JSON.stringify({
      ...answer,
      toolAction: "Finishing task",
      toolSummary: "Task completion",
    });

    send(stepEvent(step, "ACTIVE", "agent_response", { text_delta: streamed }));
    // The gate holds the answer, so a test can act while the schema turn is still running.
    await waitForGate("FAKE_SCHEMA_GATE");
    send(stepEvent(step, "DONE", "agent_response", { text_delta: "\n", usage: stepUsage }));
    step += 1;

    if (process.env.FAKE_SCHEMA_ERROR) {
      sendResult(turnResult(turns, "", "ERROR", process.env.FAKE_SCHEMA_ERROR));
      return;
    }
    send({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "SUCCESS",
        response: `${streamed}\n`,
        structured_output: answer,
        json_schema: schema,
        duration_seconds: 0.2,
        num_turns: turns,
        usage,
      },
    });
    return;
  }

  const response = `echo:${text}`;
  const middle = Math.max(1, Math.floor(response.length / 2));
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: response.slice(0, middle),
    },
  });
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: response.slice(middle),
    },
  });

  if (scenario === "edit" || scenario === "edit-applied") {
    // The captured shape of an edit: the stream names the file and nothing else, so a consumer
    // can only describe the change by comparing the file before and after the call.
    const file = process.env.FAKE_EDIT_FILE ?? `${process.cwd()}/hello.txt`;
    const toolName = process.env.FAKE_EDIT_TOOL ?? "replace_file_content";
    const toolInfo = { name: toolName, parameters: { TargetFile: file } };

    if (scenario === "edit-applied") {
      // agy applies the edit before the step is deliverable, so a consumer only ever sees the
      // file as a `view_file` step showed it. The gate opens once that step has been seen.
      send(
        stepEvent(step, "ACTIVE", "tool", {
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: file } },
        }),
      );
      await waitForGate();
      send(
        stepEvent(step, "DONE", "tool", {
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: file } },
          output: "1 line, 12 bytes",
          duration_seconds: 0.01,
        }),
      );
      step += 1;
      if (process.env.FAKE_EDIT_SKIP_WRITE !== "1") {
        writeFileSync(file, process.env.FAKE_EDIT_AFTER ?? "bye world\n");
      }
      send(stepEvent(step, "ACTIVE", "tool", { tool_name: toolName, tool_info: toolInfo }));
      send(
        stepEvent(step, "DONE", "tool", {
          tool_name: toolName,
          tool_info: toolInfo,
          duration_seconds: 0.02,
        }),
      );
      step += 1;
    } else {
      const toolStep = step;
      step += 1;
      send(stepEvent(toolStep, "ACTIVE", "tool", { tool_name: toolName, tool_info: toolInfo }));
      await waitForGate();
      if (process.env.FAKE_EDIT_SKIP_WRITE !== "1") {
        writeFileSync(file, process.env.FAKE_EDIT_AFTER ?? "bye world\n");
      }
      send(
        stepEvent(toolStep, "DONE", "tool", {
          tool_name: toolName,
          tool_info: toolInfo,
          duration_seconds: 0.02,
        }),
      );
    }
  }

  if (scenario === "tool") {
    step += 1;
    const toolInfo = { name: "run_command", parameters: { CommandLine: "ls -la" } };
    send({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: step,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: toolInfo,
      },
    });
    send({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: step,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { ...toolInfo, output: "hello.txt" },
        duration_seconds: 0.05,
      },
    });
  }

  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "\n",
      duration_seconds: 0.1,
      usage: stepUsage,
    },
  });
  sendResult({
    conversation_id: conversationId,
    status: "SUCCESS",
    response: `${response}\n`,
    duration_seconds: 0.2,
    num_turns: turns,
    usage,
  });
});
