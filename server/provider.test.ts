import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderEventSchema,
  ProviderInputSchema,
  type ProviderConnection,
  type ProviderContent,
  type ProviderEvent,
  type ProviderError,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderSessionConfig,
  type ProviderSetting,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_ACCOUNT_ID, addAccount, removeAccount, setActive } from "./accounts";
import { createProvider, resolveChildCwd } from "./provider";
import { parseTranscriptLines, renderChild } from "./subagents";
import { writeConversationDb } from "./testing/conversation-db";
import { installFakeSecurity, type FakeSecurity } from "./testing/fake-security";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));
const OFFERED = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.output_schema",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.subsession",
  "permission",
  "permission.tool_policy",
];

const originalHome = process.env.HOME;

let tempDir: string;
let argvFile: string;
let argvLog: string;
let envFile: string;
let promptFile: string;
let openConnections: ProviderConnection[];

/**
 * What Paseo's own schemas would reject, as `direction path: message`.
 *
 * The host decodes every event a provider emits with `ProviderEventSchema`, and a plugin that
 * sends something it cannot decode takes the whole session down with a runtime failure rather
 * than losing one row. Every event these tests cause — and every input they send — is decoded
 * here, so a violation fails the test that caused it instead of only the assertion that noticed.
 */
let schemaViolations: string[];
/** Account sessions sync their shadow home, whose Keychain must never be the real `/usr/bin/security`. */
let security: FakeSecurity;

function check(schema: z.ZodType, value: unknown, direction: "input" | "event"): void {
  const parsed = schema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const line = `${direction} ${issue.path.join(".")}: ${issue.message}`;
    // Deduplicated: one kind of violation is one bug, and repeating it per event buries the rest.
    if (!schemaViolations.includes(line)) schemaViolations.push(line);
  }
}

/**
 * Attaches the schema guard and the event log to a connection, and validates what is sent through
 * it. Both directions go through the same schemas the daemon uses, so the tests cannot quietly
 * exercise a message the daemon would refuse.
 */
function watchConnection(connection: ProviderConnection): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  // The daemon's own `session.opened` checks: a session may only select what was negotiated, and a
  // child may only hang off a session that selected `session.subsession`. Either failure takes the
  // whole connection down in the daemon.
  const selected = new Map<string, readonly string[]>();
  connection.onEvent((event) => {
    check(ProviderEventSchema, event, "event");
    if (event.type === "session.opened") {
      for (const capability of event.capabilities) {
        if (!connection.capabilities.includes(capability)) {
          schemaViolations.push(`event capabilities: unoffered ${capability}`);
        }
      }
      if (
        event.parentSessionId !== undefined &&
        !selected.get(event.parentSessionId)?.includes("session.subsession")
      ) {
        schemaViolations.push("event parentSessionId: parent did not negotiate session.subsession");
      }
      selected.set(event.sessionId, event.capabilities);
    }
    events.push(event);
  });
  const send = connection.send.bind(connection);
  connection.send = async (input) => {
    check(ProviderInputSchema, input, "input");
    await send(input);
  };
  return events;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-provider-"));
  argvFile = join(tempDir, "argv.json");
  argvLog = join(tempDir, "argv-log.jsonl");
  envFile = join(tempDir, "env.json");
  promptFile = join(tempDir, "prompts.jsonl");
  schemaViolations = [];

  chmodSync(fakeAgy, 0o755);
  process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
  process.env.PASEO_HOME = join(tempDir, "paseo-home");
  process.env.FAKE_ARGV_FILE = argvFile;
  process.env.FAKE_ARGV_LOG = argvLog;
  process.env.FAKE_ENV_FILE = envFile;
  process.env.FAKE_PROMPT_FILE = promptFile;
  delete process.env.FAKE_SCENARIO;
  delete process.env.FAKE_MODELS_OK;
  openConnections = [];
  security = installFakeSecurity("linux");
});

afterEach(async () => {
  await Promise.all(openConnections.map((connection) => connection.close()));
  openConnections = [];
  for (const key of [
    "PASEO_ANTIGRAVITY_BIN",
    "PASEO_HOME",
    "FAKE_ARGV_FILE",
    "FAKE_ARGV_LOG",
    "FAKE_ENV_FILE",
    "FAKE_PROMPT_FILE",
    "FAKE_SCENARIO",
    "FAKE_MODELS_OK",
    "FAKE_CONVERSATION_ID",
    "FAKE_STDERR_LINE",
    "FAKE_RESULT_ERROR",
    "FAKE_TOOL_END",
    "FAKE_RESULT_INPUT_TOKENS",
    "FAKE_STEP_INPUT_TOKENS",
    "FAKE_SCHEMA_OUTPUT",
    "FAKE_SCHEMA_ERROR",
    "FAKE_SCHEMA_GATE",
    "FAKE_SCHEMA_STICKY",
    "FAKE_SUBAGENT_COUNT",
    "FAKE_SUBAGENT_TRANSCRIPT",
    "FAKE_SUBAGENT_GATE",
    "FAKE_SUBAGENT_NESTED",
    "FAKE_SUBAGENT_NESTED_GATE",
    "FAKE_SUBAGENT_NESTED_RESUME",
    "FAKE_EDIT_FILE",
    "FAKE_EDIT_TOOL",
    "FAKE_EDIT_AFTER",
    "FAKE_EDIT_GATE",
    "FAKE_EDIT_SKIP_WRITE",
    "FAKE_BACKGROUND_GATE",
    "FAKE_BACKGROUND_RESUME",
    "FAKE_QUESTIONS",
    "FAKE_QUESTION_TOOL",
    "FAKE_QUESTION_GATE",
    "FAKE_QUESTION_EFFECT",
    "PASEO_ANTIGRAVITY_BACKFILL_DELAY_MS",
  ]) {
    delete process.env[key];
  }
  // The approval description is read from HOME, so a test that repoints it must not leak.
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  security.restore();
  rmSync(tempDir, { recursive: true, force: true });
  // Last, so every test still cleans up after itself: a provider message the host cannot decode
  // is a session-killing bug, and it is reported with the test that produced it.
  expect(schemaViolations).toEqual([]);
});

interface Harness {
  connection: ProviderConnection;
  events: ProviderEvent[];
}

async function connect(): Promise<Harness> {
  const connection = await createProvider().connect({ versions: [1], capabilities: OFFERED });
  openConnections.push(connection);
  return { connection, events: watchConnection(connection) };
}

function sessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    cwd: tempDir,
    env: {},
    mcpServers: {},
    settings: {},
    model: "gemini-3.8-flash-high",
    mode: "default",
    persist: true,
    ...overrides,
  };
}

async function openSession(
  connection: ProviderConnection,
  overrides: Partial<ProviderSessionConfig> = {},
  options: { sessionId?: string; history?: "replay" | "skip"; persistence?: ProviderPersistence } = {},
): Promise<void> {
  const input: ProviderInput = {
    type: "session.open",
    requestId: "open-1",
    sessionId: options.sessionId ?? "session-1",
    config: sessionConfig(overrides),
    history: options.history ?? "skip",
    ...(options.persistence ? { persistence: options.persistence } : {}),
  };
  await connection.send(input);
}

async function prompt(
  connection: ProviderConnection,
  text: string,
  clientMessageId = "m1",
  sessionId = "session-1",
): Promise<void> {
  await connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  });
}

async function promptContent(
  connection: ProviderConnection,
  content: ProviderContent[],
  clientMessageId = "m1",
  outputSchema?: unknown,
  sessionId = "session-1",
): Promise<void> {
  await connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content },
      ...(outputSchema === undefined ? {} : { outputSchema }),
    },
  } as ProviderInput);
}

async function waitFor<T>(
  find: () => T | undefined,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = find();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function turns(events: ProviderEvent[], state: string, sessionId = "session-1") {
  return events.filter(
    (event) => event.type === "session.turn" && event.state === state && event.sessionId === sessionId,
  );
}

function turnIds(events: ProviderEvent[], state: string): string[] {
  return events.flatMap((event) =>
    event.type === "session.turn" && event.state === state ? [event.turnId] : [],
  );
}

function timelineItems(events: ProviderEvent[]): ProviderTimelineItem[] {
  return events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
}

/**
 * What Paseo itself would compute from these events. Its plugin-provider maps every assistant
 * snapshot to a *delta* appended to the message the id belongs to
 * (`text.startsWith(previous) ? text.slice(previous.length) : text`), so a republished row that is
 * not a prefix extension appends a second answer instead of replacing the first, and a turn's
 * answer is the concatenation of its contiguous trailing assistant messages.
 */
function paseoView(events: ProviderEvent[]): { messages: Map<string, string>; finalText: string } {
  const messages = new Map<string, string>();
  let trailing: string[] = [];
  for (const item of timelineItems(events)) {
    if (item.type !== "assistant_message") {
      trailing = [];
      continue;
    }
    const previous = messages.get(item.id) ?? "";
    const delta = item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text;
    messages.set(item.id, previous + delta);
    if (!trailing.includes(item.id)) trailing.push(item.id);
  }
  return { messages, finalText: trailing.map((id) => messages.get(id) ?? "").join("") };
}

function readArgv(): string[] {
  return JSON.parse(readFileSync(argvFile, "utf8")) as string[];
}

/** The flags of every launch this test made, oldest first. */
function readArgvLog(): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function readPrompts(): string[] {
  if (!existsSync(promptFile)) return [];
  return readFileSync(promptFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as string);
}

describe("session lifecycle", () => {
  it("opens, streams an assistant message, and completes the turn", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    expect(turns(events, "started")).toHaveLength(0);
    expect(events.some((event) => event.type === "session.ready")).toBe(true);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const promptResults = events.filter(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "m1",
    );
    expect(promptResults).toHaveLength(1);
    expect(promptResults[0]).toMatchObject({ result: { type: "turn" } });

    const items = timelineItems(events);
    const userMessage = items.find((item) => item.type === "user_message");
    expect(userMessage).toMatchObject({ text: "hello", clientMessageId: "m1" });

    // The fake streams "echo:" + "hello" + "\n" as three incremental deltas, so a correct
    // accumulator ends with the whole sentence and never duplicates a prefix. Paseo's own delta
    // mapping over the published snapshots must agree.
    const assistant = items.filter((item) => item.type === "assistant_message");
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.at(-1)).toMatchObject({ text: "echo:hello\n" });
    expect(paseoView(events).finalText).toBe("echo:hello\n");

    const usage = events.find((event) => event.type === "session.usage");
    expect(usage).toMatchObject({
      type: "session.usage",
      usage: { inputTokens: 15466, outputTokens: 52 },
    });

    const persistence = events.find((event) => event.type === "session.persistence");
    expect(persistence).toMatchObject({
      persistence: { version: 1, data: { conversationId: "11111111-2222-3333-4444-555555555555" } },
    });
  });

  it("launches agy in stream mode and never in print mode", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const argv = readArgv();
    for (const flag of [
      "--input-format",
      "stream-json",
      "--output-format",
      "--add-dir",
      tempDir,
      "--disable-slash-commands",
      "--print-timeout",
      "0",
      "--model",
      "gemini-3.8-flash-high",
    ]) {
      expect(argv).toContain(flag);
    }
    // Approval follows Antigravity's own setting unless the user picks otherwise.
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("-p");
    expect(argv).not.toContain("--print");
    // `default` is agy's implicit mode, so it must not be passed explicitly.
    expect(argv).not.toContain("--mode");
    // Antigravity encodes the reasoning tier in the model id and rejects `--model X --effort Y`
    // with "conflicts with --effort", so the flag must never be sent.
    expect(argv).not.toContain("--effort");
  });

  it("passes the selected mode through to the CLI", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "accept-edits" });
    await prompt(connection, "plan something");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // `accept-edits` is the one selectable mode agy honours here; `plan` is deliberately never
    // passed (see the plan-mode tests), and `default` is agy's own default.
    const argv = readArgv();
    expect(argv[argv.indexOf("--mode") + 1]).toBe("accept-edits");
    expect(argv).toContain("--disable-slash-commands");
  });

  it("reports the model and mode selectors in the committed config", async () => {
    const { connection, events } = await connect();
    await openSession(connection);

    const config = events.find((event) => event.type === "session.config");
    expect(config).toMatchObject({
      config: {
        model: "gemini-3.8-flash-high",
        mode: "default",
        modes: expect.arrayContaining([expect.objectContaining({ id: "accept-edits" })]),
        // A slug persisted before tiers existed still reports the tier it launches with.
        thinkingOption: "high",
        thinkingOptions: [
          { id: "high", label: "High" },
          { id: "medium", label: "Medium" },
          { id: "low", label: "Low" },
        ],
      },
    });
    if (config?.type === "session.config") {
      expect(config.config.models.length).toBeGreaterThan(0);
    }
  });

  it("reports no tier for a model that has none", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "claude-opus-4-6-thinking" });

    expect(events.find((event) => event.type === "session.config")).toMatchObject({
      config: { model: "claude-opus-4-6-thinking", thinkingOptions: [] },
    });
  });

  it("ignores an init event whose conversation id is empty", async () => {
    process.env.FAKE_CONVERSATION_ID = "";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // An unnamed conversation must not be persisted, nor adopted as the session's identity.
    expect(events.some((event) => event.type === "session.persistence")).toBe(false);

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );
    const transcripts = join(
      process.env.PASEO_HOME ?? "",
      "plugin-data",
      "antigravity-cli",
      "transcripts",
    );
    // The empty id names this file; a stray file from another session's store is not ours.
    expect(existsSync(join(transcripts, ".jsonl"))).toBe(false);
  });
});

describe("thinking tiers", () => {
  it("launches the family slug with the tier the composer chose", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "gemini-3.8-flash", thinkingOption: "low" });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // The tier is part of the model id, and `--effort` is rejected alongside it.
    expect(readArgv()[readArgv().indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(readArgv()).not.toContain("--effort");
  });

  it("launches a full slug persisted before tiers existed unchanged", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "gemini-3.8-flash-high", thinkingOption: undefined });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readArgv()[readArgv().indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
  });

  it("relaunches with the new tier on the next turn", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "gemini-3.8-flash", thinkingOption: "high" });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgv()[readArgv().indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-tier",
      sessionId: "session-1",
      changes: { thinkingOption: "low" },
    } as ProviderInput);

    expect(events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({
      config: { thinkingOption: "low" },
    });

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    // The tier is a launch-time flag, so the CLI is replaced on the same conversation.
    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });
});

describe("effort from providerOptions", () => {
  it("lets an explicit composer tier win over providerOptions.effort", async () => {
    const { connection, events } = await connect();
    await openSession(connection, {
      model: "gemini-3.8-flash",
      thinkingOption: "high",
      providerOptions: { effort: "low" },
    });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(argv).not.toContain("--effort");
  });

  it("drops an effort the model has no tier for, and says so once", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]): void => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { connection, events } = await connect();
      await openSession(connection, {
        model: "gemini-3.8-flash",
        providerOptions: { effort: "max" },
      });
      await prompt(connection, "hello");
      await waitFor(() => turns(events, "completed")[0], "the turn to complete");

      const argv = readArgv();
      // `max` is not one of flash's tiers, so the launch keeps the family's default tier and the
      // rejected flag is not invented into the argv.
      expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
      expect(argv).not.toContain("--effort");
    } finally {
      spy.mockRestore();
    }

    const ignored = logged.filter((line) => line.includes("ignoring effort"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain('"max"');
    expect(ignored[0]).toContain("gemini-3.8-flash");
  });

  it("drops an effort for a model without tiers, and says so once", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]): void => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { connection, events } = await connect();
      await openSession(connection, {
        model: "claude-opus-4-6-thinking",
        providerOptions: { effort: "max" },
      });
      await prompt(connection, "hello");
      await waitFor(() => turns(events, "completed")[0], "the turn to complete");

      // agy answers `--effort is not supported for model "claude-opus-4-6-thinking"`, and there is
      // no tier to fold into the slug either, so the launch carries neither.
      const argv = readArgv();
      expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-6-thinking");
      expect(argv).not.toContain("--effort");
    } finally {
      spy.mockRestore();
    }

    const ignored = logged.filter((line) => line.includes("ignoring effort"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain('"max"');
    expect(ignored[0]).toContain("claude-opus-4-6-thinking");
  });

  it("passes --effort alone when no model was selected", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: undefined, providerOptions: { effort: "low" } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // The CLI applies the effort to its own default model, so no --model may be sent with it.
    const argv = readArgv();
    expect(argv).not.toContain("--model");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
  });

  it("adopts the effort's tier on a model chosen after the session opened", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: undefined, providerOptions: { effort: "low" } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    // No model picked: the effort rides alone, on the model the CLI picks for itself.
    expect(readArgv()).not.toContain("--model");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-model",
      sessionId: "session-1",
      changes: { model: "gemini-3.8-flash" },
    } as ProviderInput);

    // The composer is told the tier the effort asked for, because the launch is about to use it.
    expect(events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({
      config: { model: "gemini-3.8-flash", thinkingOption: "low" },
    });

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");
    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(argv).not.toContain("--effort");
  });

  it("drops an effort the default model has no tier for", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]): void => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { connection, events } = await connect();
      await openSession(connection, { model: undefined, providerOptions: { effort: "max" } });
      await prompt(connection, "hello");
      await waitFor(() => turns(events, "completed")[0], "the turn to complete");

      // `agy --effort max` alone answers `gemini-3.8-flash has no "max" effort`, so neither flag
      // may be sent to reproduce that failure.
      const argv = readArgv();
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("--effort");
    } finally {
      spy.mockRestore();
    }

    const ignored = logged.filter((line) => line.includes("ignoring effort"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain('"max"');
    expect(ignored[0]).toContain("gemini-3.8-flash");
  });
});

describe("tool approval", () => {
  function approvalSetting(events: ProviderEvent[]): ProviderSetting | undefined {
    const config = events.filter((event) => event.type === "session.config").at(-1);
    return config?.type === "session.config"
      ? config.config.settings.find((setting) => setting.id === "approvalPolicy")
      : undefined;
  }

  it("offers Antigravity's own setting as the default policy", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(approvalSetting(events)).toMatchObject({
      type: "select",
      value: "agy",
      options: [
        { label: "Use Antigravity setting", value: "agy" },
        { label: "Skip all permissions", value: "skip" },
      ],
    });
    expect(readArgv()).not.toContain("--dangerously-skip-permissions");
  });

  it("adds the skip flag on the next turn after the policy is switched", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgv()).not.toContain("--dangerously-skip-permissions");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { settings: { approvalPolicy: "skip" } },
    } as ProviderInput);

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    expect(readArgv()).toContain("--dangerously-skip-permissions");
    expect(approvalSetting(events)).toMatchObject({ value: "skip" });
  });

  it("treats a persisted autoApprove setting as skip", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { settings: { autoApprove: true } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readArgv()).toContain("--dangerously-skip-permissions");
    expect(approvalSetting(events)).toMatchObject({ value: "skip" });
  });

  it("names the Antigravity toolPermission that will decide approval", async () => {
    const home = join(tempDir, "home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ toolPermission: "request-review" }),
    );
    process.env.HOME = home;

    const { connection, events } = await connect();
    await openSession(connection);

    expect(approvalSetting(events)).toMatchObject({
      description: expect.stringContaining("request-review"),
    });
  });

  it("says unknown when Antigravity's settings cannot be read", async () => {
    const missing = join(tempDir, "empty-home");
    const invalid = join(tempDir, "invalid-home");
    mkdirSync(join(invalid, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(invalid, ".gemini", "antigravity-cli", "settings.json"), "{ not json");

    for (const home of [missing, invalid]) {
      mkdirSync(home, { recursive: true });
      process.env.HOME = home;
      const { connection, events } = await connect();
      await openSession(connection);

      expect(approvalSetting(events)).toMatchObject({
        description: expect.stringContaining("unknown"),
      });
    }
  });
});

describe("launch settings", () => {
  function setting(events: ProviderEvent[], id: string): ProviderSetting | undefined {
    const config = events.filter((event) => event.type === "session.config").at(-1);
    return config?.type === "session.config"
      ? config.config.settings.find((candidate) => candidate.id === id)
      : undefined;
  }

  /**
   * Points HOME at a temp home that trusts this workspace. agy only reads a workspace's agents
   * once the workspace is trusted, and the trust lives in `settings.json` under HOME — the
   * developer's own HOME must never be the one a test reads or writes. Both the temp path and its
   * resolved one are listed: on macOS the temp directory is a symlink under `/private`.
   */
  function trustedHome(): void {
    const home = join(tempDir, "home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ trustedWorkspaces: [tempDir, realpathSync(tempDir)] }),
      "utf8",
    );
    process.env.HOME = home;
  }

  it("adds --sandbox on the next turn after the select is switched", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgv()).not.toContain("--sandbox");
    expect(setting(events, "sandbox")).toMatchObject({ type: "select", value: "off" });

    await connection.send({
      type: "session.configure",
      requestId: "cfg-sandbox",
      sessionId: "session-1",
      changes: { settings: { sandbox: "on" } },
    } as ProviderInput);
    expect(setting(events, "sandbox")).toMatchObject({ type: "select", value: "on" });

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");
    expect(readArgv()).toContain("--sandbox");
  });

  it("offers the boolean settings as On/Off selects", async () => {
    const { connection, events } = await connect();
    await openSession(connection);

    const settings = (() => {
      const config = events.filter((event) => event.type === "session.config").at(-1);
      return config?.type === "session.config" ? config.config.settings : [];
    })();
    // Paseo renders a plugin toggle as an icon-only button with no on/off state, so a boolean
    // setting must be a select; `session.config` carries no toggle at all.
    expect(settings.some((candidate) => candidate.type === "toggle")).toBe(false);
    expect(settings.find((candidate) => candidate.id === "sandbox")).toMatchObject({
      type: "select",
      value: "off",
      options: [
        { label: "Off", value: "off" },
        { label: "On", value: "on" },
      ],
    });
    expect(settings.find((candidate) => candidate.id === "shareMcp")).toMatchObject({
      type: "select",
      value: "off",
    });
  });

  it("reads a boolean saved while the settings were toggles", async () => {
    const { connection, events } = await connect();
    await openSession(connection, {
      settings: { sandbox: true, shareMcp: true },
      mcpServers: { github: { type: "stdio", command: "gh-mcp" } },
    });

    expect(setting(events, "sandbox")).toMatchObject({ type: "select", value: "on" });
    expect(setting(events, "shareMcp")).toMatchObject({ type: "select", value: "on" });
    expect(existsSync(join(tempDir, ".agents", "mcp_config.json"))).toBe(true);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    expect(readArgv()).toContain("--sandbox");

    // The other direction: `"off"` turns the flag off again on the next launch.
    await connection.send({
      type: "session.configure",
      requestId: "cfg-off",
      sessionId: "session-1",
      changes: { settings: { sandbox: "off" } },
    } as ProviderInput);
    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");
    expect(setting(events, "sandbox")).toMatchObject({ value: "off" });
    expect(readArgv()).not.toContain("--sandbox");
  });

  it("opens and closes the composer's settings probe without side effects", async () => {
    // The draft composer opens a throwaway session, with empty settings, on every model, mode, and
    // tier change: it must neither launch the CLI nor write anything outside plugin-data.
    const cwd = join(tempDir, "workspace");
    mkdirSync(cwd);
    const logged: string[] = [];
    // A launch is logged synchronously by the process factory, so this catches one whether or not
    // the child would have lived long enough to report for itself.
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]): void => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { connection, events } = await connect();
      await openSession(connection, { cwd });
      await connection.send({
        type: "session.close",
        requestId: "close-probe",
        sessionId: "session-1",
      });
      await waitFor(
        () => events.find((event) => event.type === "session.closed"),
        "the probe session to close",
      );
    } finally {
      spy.mockRestore();
    }

    expect(logged.filter((line) => line.includes("spawn"))).toEqual([]);
    expect(readArgvLog()).toEqual([]);
    const outside: string[] = [];
    const walk = (from: string): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const path = join(from, entry.name);
        if (entry.isDirectory()) walk(path);
        else outside.push(path);
      }
    };
    walk(tempDir);
    const dataDir = join(process.env.PASEO_HOME ?? "", "plugin-data");
    expect(outside.filter((path) => !path.startsWith(dataDir))).toEqual([]);
  });

  it("passes the extra directories that exist and drops the rest with a warning", async () => {
    const extra = join(tempDir, "extra");
    const file = join(tempDir, "notes.txt");
    mkdirSync(extra);
    writeFileSync(file, "not a directory");
    const missing = join(tempDir, "missing");

    const { connection, events } = await connect();
    await openSession(connection, {
      providerOptions: { addDirs: [extra, "relative/dir", missing, file] },
    });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // One --add-dir per accepted path, after the workspace and the attachments folder.
    const argv = readArgv();
    expect(argv.flatMap((arg, index) => (arg === "--add-dir" ? [argv[index + 1]] : []))).toEqual([
      tempDir,
      expect.stringContaining("attachments"),
      extra,
    ]);
    for (const rejected of ["relative/dir", missing, file]) {
      expect(argv).not.toContain(rejected);
    }

    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "add-dirs-dropped",
    );
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
    if (notice?.type === "session.notice") {
      for (const rejected of ["relative/dir", missing, file]) {
        expect(notice.notice.description).toContain(rejected);
      }
    }
  });

  it("passes --agent and resolves an effort into the model tier from providerOptions", async () => {
    const { connection, events } = await connect();
    await openSession(connection, {
      model: "gemini-3.8-flash",
      providerOptions: { agent: "code-reviewer", effort: "low" },
    });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // The effort is the same knob as the composer's tier, so it lands in the slug, not in a flag
    // the CLI would reject next to that slug.
    const argv = readArgv();
    expect(argv).toContain("--agent");
    expect(argv[argv.indexOf("--agent") + 1]).toBe("code-reviewer");
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(argv).not.toContain("--effort");
  });

  it("exposes an agent profile setting when custom agents are present and passes --agent", async () => {
    trustedHome();
    const agentDir = join(tempDir, ".agents", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "reviewer.md"),
      "---\nname: my-custom-agent\ndescription: Custom reviewer\n---\nPrompt here",
      "utf8",
    );

    const { connection, events } = await connect();
    await openSession(connection);

    const configEvent = events.find((e) => e.type === "session.config");
    expect(configEvent).toBeDefined();
    if (configEvent?.type === "session.config") {
      const agentSetting = configEvent.config.settings.find((s) => s.id === "agent");
      expect(agentSetting).toBeDefined();
      if (agentSetting && agentSetting.type === "select") {
        expect(agentSetting.options.some((o) => o.value === "my-custom-agent")).toBe(true);
      }
    }

    // Configure the session with the custom agent
    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { settings: { agent: "my-custom-agent" } },
    });

    await prompt(connection, "test turn");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const argv = readArgv();
    expect(argv).toContain("--agent");
    expect(argv[argv.indexOf("--agent") + 1]).toBe("my-custom-agent");
  });

  it("passes a providerOptions agent this workspace does not list, and offers it in the select", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { providerOptions: { agent: "code-reviewer" } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // The CLI may know an agent a workspace scan does not, so the name is passed anyway — and the
    // select has to offer it, or the row would show a value that is not among its own options.
    expect(setting(events, "agent")).toMatchObject({ type: "select", value: "code-reviewer" });
    const agentSetting = setting(events, "agent");
    expect(agentSetting?.type === "select" ? agentSetting.options : []).toContainEqual({
      label: "code-reviewer",
      value: "code-reviewer",
    });
    expect(readArgv()[readArgv().indexOf("--agent") + 1]).toBe("code-reviewer");
  });

  it("takes --agent off the CLI when the setting is the default agent", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { providerOptions: { agent: "code-reviewer" } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgv()).toContain("--agent");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-default",
      sessionId: "session-1",
      changes: { settings: { agent: "default" } },
    } as ProviderInput);
    expect(setting(events, "agent")).toMatchObject({ type: "select", value: "default" });

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    // "Default" is a choice the user made, not the absence of one, so it beats the provider option
    // instead of falling back to it.
    expect(readArgv()).not.toContain("--agent");
  });
});

describe("Paseo MCP sharing", () => {
  const SERVERS = {
    paseo: {
      type: "stdio",
      command: "paseo-mcp",
      args: ["serve"],
      env: { PASEO_TOKEN: "secret" },
    },
  } satisfies ProviderSessionConfig["mcpServers"];
  const configPath = () => join(tempDir, ".agents", "mcp_config.json");
  const ledgerPath = () => join(tempDir, "paseo-home", "plugin-data", "antigravity-cli", "mcp-ledger.json");
  const readConfig = () =>
    JSON.parse(readFileSync(configPath(), "utf8")) as { mcpServers: Record<string, unknown> };
  const notices = (events: ProviderEvent[], id: string) =>
    events.filter((event) => event.type === "session.notice" && event.notice.id === id);

  it("writes Paseo's servers into the workspace config before the CLI starts", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });

    // The CLI reads the file at startup, so it has to be there before anything is launched.
    expect(readArgvLog()).toEqual([]);
    expect(readConfig().mcpServers).toEqual({
      "paseo-paseo": {
        args: ["serve"],
        command: "paseo-mcp",
        disabled: false,
        env: { PASEO_TOKEN: "secret" },
      },
    });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);

    const notice = notices(events, "mcp-shared")[0];
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
    if (notice?.type === "session.notice") {
      // The file holds credentials and is inside the user's repository.
      expect(notice.notice.description).toContain(configPath());
      expect(notice.notice.description).not.toContain("secret");
    }
    expect(notices(events, "mcp-unsupported")).toEqual([]);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    expect(readArgvLog()).toHaveLength(1);
    expect(readConfig().mcpServers).toHaveProperty("paseo-paseo");
  });

  it("adds the entries on the next turn after the select is switched on", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mcpServers: SERVERS });
    expect(existsSync(configPath())).toBe(false);
    expect(notices(events, "mcp-unsupported")).toHaveLength(1);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgvLog()).toHaveLength(1);

    await connection.send({
      type: "session.configure",
      requestId: "cfg-mcp",
      sessionId: "session-1",
      changes: { settings: { shareMcp: "on" } },
    } as ProviderInput);
    expect(existsSync(configPath())).toBe(false);

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");
    // The CLI only reads the file at startup, so the toggle rides the same relaunch as a flag.
    expect(readArgvLog()).toHaveLength(2);
    expect(readConfig().mcpServers).toHaveProperty("paseo-paseo");
    expect(notices(events, "mcp-shared")).toHaveLength(1);
  });

  it("keeps two sessions in one workspace from removing each other's entries", async () => {
    const { connection } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } }, { sessionId: "session-2" });

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    expect(readConfig().mcpServers).toHaveProperty("paseo-paseo");

    await connection.send({ type: "session.close", requestId: "close-2", sessionId: "session-2" });
    // The plugin created the file, so nothing is left to keep it around.
    expect(existsSync(configPath())).toBe(false);
  });

  it("releases the entries when the connection closes", async () => {
    const { connection } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });
    expect(existsSync(configPath())).toBe(true);

    await connection.close();

    expect(existsSync(configPath())).toBe(false);
  });

  it("removes the entries of a session that died without closing", async () => {
    mkdirSync(join(tempDir, ".agents"), { recursive: true });
    writeFileSync(
      configPath(),
      `${JSON.stringify(
        {
          mcpServers: {
            github: { command: "gh-mcp", disabled: false },
            "paseo-ghost": { command: "ghost", disabled: false },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    mkdirSync(join(tempDir, "paseo-home", "plugin-data", "antigravity-cli"), { recursive: true });
    writeFileSync(
      ledgerPath(),
      `${JSON.stringify(
        { version: 1, workspaces: { [tempDir]: { created: false, entries: { "paseo-ghost": ["ghost"] } } } },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { connection } = await connect();
    await openSession(connection);

    expect(readConfig().mcpServers).toEqual({ github: { command: "gh-mcp", disabled: false } });
    expect(JSON.parse(readFileSync(ledgerPath(), "utf8")).workspaces).toEqual({});
  });

  it("leaves an invalid workspace config alone and says so", async () => {
    mkdirSync(join(tempDir, ".agents"), { recursive: true });
    writeFileSync(configPath(), "{ not json", "utf8");

    const { connection, events } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });

    expect(readFileSync(configPath(), "utf8")).toBe("{ not json");
    const notice = notices(events, "mcp-config-invalid")[0];
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
    if (notice?.type === "session.notice") {
      expect(notice.notice.description).toContain(configPath());
    }

    // The session is still usable; only the sharing was skipped.
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
  });
});

describe("usage", () => {
  function lastUsage(events: ProviderEvent[]) {
    const usage = events.filter((event) => event.type === "session.usage").at(-1);
    return usage?.type === "session.usage" ? usage.usage : undefined;
  }

  it("reports the last step's input tokens as the context occupancy", async () => {
    // Captured shape: the result totals every step (31074 = 15388 + 15686) while the final step
    // reports what the model actually held in its context window.
    process.env.FAKE_RESULT_INPUT_TOKENS = "31074";
    process.env.FAKE_STEP_INPUT_TOKENS = "15686";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(lastUsage(events)).toMatchObject({
      inputTokens: 31074,
      outputTokens: 52,
      contextWindowUsedTokens: 15686,
    });
  });

  it("omits the context occupancy when no step reported usage", async () => {
    process.env.FAKE_SCENARIO = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    const usage = lastUsage(events);
    expect(usage).toMatchObject({ inputTokens: 15466 });
    expect(usage).not.toHaveProperty("contextWindowUsedTokens");
  });
});

describe("queued prompts", () => {
  it("keeps a queued prompt from truncating the running answer", async () => {
    process.env.FAKE_SCENARIO = "queued";
    const { connection, events } = await connect();
    await openSession(connection);

    await prompt(connection, "one", "m1");
    // The fake streams half of turn 1's answer and then waits for a second stdin line, so the
    // queued prompt below lands while that turn is still running.
    await waitFor(
      () => timelineItems(events).find((item) => item.type === "assistant_message"),
      "turn 1 to start streaming",
    );
    await prompt(connection, "two", "m2");

    await waitFor(
      () => (turnIds(events, "completed").length === 2 ? true : undefined),
      "both turns to complete",
    );

    const assistant = timelineItems(events).filter((item) => item.type === "assistant_message");
    const firstId = assistant[0]?.id;
    const firstRow = assistant.filter((item) => item.id === firstId);
    expect(firstRow[0]).toMatchObject({ text: "echo" });
    // Turn 1 keeps one row, and its last snapshot is the whole answer, not the pre-queue prefix.
    expect(firstRow.at(-1)).toMatchObject({ text: "echo:one\n" });

    // One row per turn, each carrying its own turn id, and one completion per turn in order.
    const startedIds = turnIds(events, "started");
    expect(startedIds).toHaveLength(2);
    expect(turnIds(events, "completed")).toEqual(startedIds);
    expect(new Set(assistant.map((item) => item.id)).size).toBe(2);

    expect(firstId).toContain(startedIds[0]);
    const secondRow = assistant.find((item) => item.id !== firstId);
    expect(secondRow?.id).toContain(startedIds[1]);
    expect(assistant.filter((item) => item.id === secondRow?.id).at(-1)).toMatchObject({
      text: "echo:two\n",
    });
  });
});

describe("prompt content", () => {
  it("prepends the system prompt to the first turn of a new conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readPrompts()[0]).toBe(
      "<system_instructions>\nBe terse.\n</system_instructions>\n\nhello",
    );
  });

  it("does not repeat the system prompt on a later turn", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });
    await prompt(connection, "first", "m1");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    await prompt(connection, "second", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    expect(readPrompts()).toEqual(["<system_instructions>\nBe terse.\n</system_instructions>\n\nfirst", "second"]);
  });

  it("never prepends the system prompt when resuming a conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const conversationId = "11111111-2222-3333-4444-555555555555";
    await connection.send({
      type: "session.open",
      requestId: "open-2",
      sessionId: "session-2",
      config: sessionConfig({ systemPrompt: "Be terse." }),
      history: "skip",
      persistence: { version: 1, data: { conversationId } },
    } as ProviderInput);

    await prompt(connection, "again", "m2", "session-2");
    await waitFor(() => turns(events, "completed", "session-2")[0], "the resumed turn");

    expect(readPrompts().at(-1)).toBe("again");
    expect(readArgv()).toContain("--conversation");
    expect(readArgv()[readArgv().indexOf("--conversation") + 1]).toBe(conversationId);
  });

  it("renders attachments as text instead of dropping them", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "review this" },
            { type: "github_pr", mimeType: "application/github-pr", number: 7, title: "Fix bug", url: "https://example.com/pr/7", body: "Details" },
          ],
        },
      },
    } as ProviderInput);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readPrompts()[0]).toBe("review this\n\n[Fix bug](https://example.com/pr/7)\n\nDetails");
  });

  it("warns that MCP servers cannot be applied", async () => {
    const { connection, events } = await connect();
    await openSession(connection, {
      mcpServers: { github: { type: "stdio", command: "gh-mcp" } },
    });

    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "mcp-unsupported",
    );
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
  });
});

describe("structured output", () => {
  const SCHEMA = {
    type: "object",
    properties: { color: { type: "string" }, count: { type: "number" } },
    required: ["color", "count"],
  };

  function lastAssistant(events: ProviderEvent[]) {
    return timelineItems(events)
      .filter((item) => item.type === "assistant_message")
      .at(-1);
  }

  it("answers a schema prompt with the decoded JSON as the only assistant row Paseo sees", async () => {
    process.env.FAKE_SCENARIO = "schema";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "which color?" }], "m1", SCHEMA);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const assistant = timelineItems(events).filter((item) => item.type === "assistant_message");
    // Paseo reads the answer from the last assistant row, so that row must be the JSON alone.
    expect(lastAssistant(events)).toMatchObject({ text: '{"color":"blue","count":8}' });
    // One row, added on the result: a schema turn streams no assistant rows, and agy's response
    // (the same JSON plus toolAction/toolSummary) never reaches the timeline.
    expect(new Set(assistant.map((item) => item.id)).size).toBe(1);
    expect(assistant.some((item) => item.text.includes("toolAction"))).toBe(false);
    expect(timelineItems(events).at(-1)).toMatchObject({ type: "assistant_message" });

    // What Paseo actually builds the turn's answer from: its delta mapping must yield the decoded
    // JSON alone. agy streams that answer with toolAction/toolSummary added, so a schema turn that
    // streamed and then republished its row would end up as one message holding both texts.
    expect(paseoView(events).finalText).toBe('{"color":"blue","count":8}');

    // The CLI received the schema as a file, and it was valid JSON.
    const argv = readArgv();
    const schemaPath = argv[argv.indexOf("--json-schema") + 1];
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(SCHEMA);

    // Replay is what a reopened agent shows, and it holds the JSON alone.
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );
    const replayed = await connect();
    await replayed.connection.send({
      type: "session.open",
      requestId: "open-replay",
      sessionId: "session-replay",
      config: sessionConfig(),
      history: "replay",
      persistence: {
        version: 1,
        data: { conversationId: "11111111-2222-3333-4444-555555555555" },
      },
    } as ProviderInput);
    expect(
      timelineItems(replayed.events)
        .filter((item) => item.type === "assistant_message")
        .map((item) => item.text),
    ).toEqual(['{"color":"blue","count":8}']);
  });

  it("relaunches without the schema flag for the next plain turn", async () => {
    process.env.FAKE_SCENARIO = "schema";
    // agy keeps the schema with the conversation, so the flagless process still reports the
    // schema's last structured_output: the plain turn must answer with its own text anyway.
    process.env.FAKE_SCHEMA_STICKY = "1";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "first" }], "m1", SCHEMA);
    await waitFor(() => turns(events, "completed")[0], "the schema turn");
    await prompt(connection, "second", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn");

    // Two processes: the schema turn's, then a fresh one for the plain turn on the same
    // conversation. Antigravity keeps the history, so the answer is not lost to the restart.
    const launches = readArgvLog();
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--json-schema");
    expect(launches[1]).not.toContain("--json-schema");
    expect(launches[1]?.[launches[1].indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    // The second process is not in schema mode: its answer streams as plain text, and the
    // conversation's stale schema answer is not published in its place.
    expect(lastAssistant(events)).toMatchObject({ text: "echo:second\n" });
    expect(paseoView(events).finalText).toBe("echo:second\n");
  });

  it("refuses a schema prompt while a turn is running", async () => {
    // This scenario stays silent, so the first turn is still running when the second arrives.
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await promptContent(connection, [{ type: "text", text: "with schema" }], "m2", SCHEMA);
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "m2" &&
            event.result.type === "failed",
        ),
      "the schema prompt to be refused",
    );
    expect(refusal).toMatchObject({ result: { type: "failed", error: { code: "busy" } } });

    // Nothing reached the CLI and no second process was spawned. The first prompt is awaited
    // because its write lands asynchronously in the CLI.
    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the running turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["long task"]);
    expect(readArgvLog()).toHaveLength(1);

    // The running turn itself is untouched.
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("refuses a plain prompt while a schema turn is running", async () => {
    process.env.FAKE_SCENARIO = "schema";
    // The gate holds the schema turn open, so the plain prompt below lands while it runs.
    const gate = join(tempDir, "schema-gate");
    process.env.FAKE_SCHEMA_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "first" }], "m1", SCHEMA);
    await waitFor(
      () => (readArgvLog().some((argv) => argv.includes("--json-schema")) ? true : undefined),
      "the schema CLI to start",
    );

    await prompt(connection, "second", "m2");
    // A running schema process answers every turn it is given against the schema, and it cannot be
    // replaced while it still owes a turn, so the plain prompt is refused instead of queued.
    const answer = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "m2",
        ),
      "the plain prompt to be answered",
    );
    expect(answer).toMatchObject({
      result: {
        type: "failed",
        error: { code: "busy", message: expect.stringContaining("structured-output") },
      },
    });

    // Nothing reached the CLI and no second process was started.
    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the schema turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["first"]);
    expect(readArgvLog()).toHaveLength(1);

    // Releasing the schema turn lets it finish, and the session still runs plain turns.
    writeFileSync(gate, "");
    await waitFor(() => turns(events, "completed")[0], "the schema turn to complete");
    expect(lastAssistant(events)).toMatchObject({ text: '{"color":"blue","count":8}' });

    await prompt(connection, "third", "m3");
    await waitFor(() => turns(events, "completed")[1], "the plain turn");
    expect(readArgvLog()).toHaveLength(2);
    expect(readArgvLog()[1]).not.toContain("--json-schema");
    expect(lastAssistant(events)).toMatchObject({ text: "echo:third\n" });
  });

  it("publishes what a schema turn said when the turn fails", async () => {
    process.env.FAKE_SCENARIO = "schema";
    process.env.FAKE_SCHEMA_ERROR = "UNAVAILABLE (code 503): The service is currently unavailable.";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "answer" }], "m1", SCHEMA);

    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(turn).toMatchObject({ error: { code: "unavailable" } });

    // The prose the schema turn buffered is published once, before the terminal turn event, so a
    // failed structured turn still shows what was said.
    const published = timelineItems(events).filter((item) => item.type === "assistant_message");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      text: '{"color":"blue","count":8,"toolAction":"Finishing task","toolSummary":"Task completion"}\n',
    });
    const failedIndex = events.findIndex(
      (event) => event.type === "session.turn" && event.state === "failed",
    );
    const itemIndex = events.findIndex(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(itemIndex).toBeLessThan(failedIndex);
  });

  it("fails the turn when agy rejects the schema file", async () => {
    // agy 1.2.9 exits 1 with no stdout for a schema it cannot read, so the turn must come back
    // as a failure instead of waiting for a result that will never arrive.
    process.env.FAKE_SCENARIO = "schema-invalid";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "answer" }], "m1", SCHEMA);

    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(turn).toMatchObject({
      error: { code: "agy_exit", message: expect.stringContaining("invalid --json-schema") },
    });
    expect(timelineItems(events).filter((item) => item.type === "assistant_message")).toEqual([]);
  });

  it("refuses a schema agy cannot start with, without replacing the running CLI", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello", "m1");
    await waitFor(() => turns(events, "completed")[0], "the plain turn");

    const refused = [
      { type: "array", items: { type: "string" } },
      { anyOf: [{ type: "string" }] },
      "string",
    ];
    for (const [index, schema] of refused.entries()) {
      await promptContent(connection, [{ type: "text", text: "answer" }], `s${index}`, schema);
      const answer = await waitFor(
        () =>
          events.find(
            (event) =>
              event.type === "session.prompt_result" && event.clientMessageId === `s${index}`,
          ),
        "the schema prompt to be answered",
      );
      expect(answer).toMatchObject({
        result: {
          type: "failed",
          error: { code: "schema_unsupported", message: expect.stringContaining('"type": "object"') },
        },
      });
    }

    // The CLI that answered the plain turn is the only one ever launched, and it still answers.
    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second plain turn");
    expect(readArgvLog()).toHaveLength(1);
    expect(readPrompts()).toEqual(["hello", "again"]);
  });

  it("adds the object type to a schema that only lists properties", async () => {
    process.env.FAKE_SCENARIO = "schema";
    const { connection, events } = await connect();
    await openSession(connection);
    const { type: _type, ...untyped } = SCHEMA;
    await promptContent(connection, [{ type: "text", text: "which color?" }], "m1", untyped);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const argv = readArgv();
    const schemaPath = argv[argv.indexOf("--json-schema") + 1];
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(SCHEMA);
  });

  it("fails a schema turn when the turn itself fails", async () => {
    process.env.FAKE_SCENARIO = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "answer" }], "m1", SCHEMA);

    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(turn).toMatchObject({ error: { code: "ERROR" } });
    // A failed turn publishes no answer, schema or not.
    expect(timelineItems(events).filter((item) => item.type === "assistant_message")).toEqual([]);
  });
});

describe("image and file attachments", () => {
  /** Enough of a PNG to prove the bytes survive the base64 round trip. */
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  function attachmentsPath(sessionId = "session-1"): string {
    return join(
      process.env.PASEO_HOME ?? "",
      "plugin-data",
      "antigravity-cli",
      "attachments",
      sessionId,
    );
  }

  it("writes attached images and points the prompt at their absolute paths", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [
      { type: "text", text: "what color is this?" },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/jpeg" },
    ]);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const dir = attachmentsPath();
    // agy rejects image blocks, so the model is told where the file is and reads it with view_file.
    expect(readPrompts()[0]).toBe(
      [
        "what color is this?",
        "",
        `[image attached: ${join(dir, "1.png")} — view it with view_file]`,
        "",
        `[image attached: ${join(dir, "2.jpg")} — view it with view_file]`,
      ].join("\n"),
    );
    expect(readFileSync(join(dir, "1.png"))).toEqual(PNG);
    expect(readFileSync(join(dir, "2.jpg"))).toEqual(PNG);

    // The folder is passed as a second --add-dir, right after the workspace one.
    const argv = readArgv();
    const first = argv.indexOf("--add-dir");
    expect(argv.slice(first, first + 4)).toEqual(["--add-dir", tempDir, "--add-dir", dir]);

    // Nothing is left behind once the session closes.
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );
    expect(existsSync(dir)).toBe(false);
  });

  it("fails the prompt when the attachments folder cannot be created", async () => {
    // A file where the sessions' attachments folder belongs makes every mkdir below it fail.
    const home = join(tempDir, "blocked-home");
    mkdirSync(join(home, "plugin-data", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "plugin-data", "antigravity-cli", "attachments"), "");
    process.env.PASEO_HOME = home;

    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
    ]);

    const refusal = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.result.type === "failed",
        ),
      "the prompt to be refused",
    );
    expect(refusal).toMatchObject({
      result: { type: "failed", error: { code: "attachment_failed" } },
    });
    // Nothing reached the CLI and no turn was started.
    expect(readPrompts()).toEqual([]);
    expect(turns(events, "started")).toEqual([]);
  });

  it("puts an uploaded file where agy may read it, numbered after the images", async () => {
    // Probed on 1.2.14 (fixtures/25): without `allowNonWorkspaceAccess`, a headless read of a file
    // under ~/.paseo/uploads is auto-denied, while one inside an --add-dir is read.
    const upload = join(tempDir, "paseo-uploads", "upload_1", "Q3 report.pdf");
    mkdirSync(dirname(upload), { recursive: true });
    writeFileSync(upload, "%PDF-1.4 probe");
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [
      { type: "text", text: "summarise" },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      {
        type: "uploaded_file",
        id: "u1",
        fileName: "Q3 report.pdf",
        mimeType: "application/pdf",
        size: 14,
        path: upload,
      },
    ]);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const placed = join(attachmentsPath(), "2-Q3_report.pdf");
    expect(readPrompts()[0]).toBe(
      [
        "summarise",
        "",
        `[image attached: ${join(attachmentsPath(), "1.png")} — view it with view_file]`,
        "",
        `[uploaded file: ${placed} (Q3 report.pdf, application/pdf)]`,
      ].join("\n"),
    );
    expect(readFileSync(placed, "utf8")).toBe("%PDF-1.4 probe");

    // Closing the session removes the placed copy, never the upload Paseo owns.
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(() => events.find((event) => event.type === "session.closed"), "the session to close");
    expect(existsSync(placed)).toBe(false);
    expect(readFileSync(upload, "utf8")).toBe("%PDF-1.4 probe");
  });

  it("fails the prompt when the uploaded file is gone", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [
      { type: "text", text: "summarise" },
      {
        type: "uploaded_file",
        id: "u1",
        fileName: "gone.pdf",
        mimeType: "application/pdf",
        size: 1,
        path: join(tempDir, "missing", "gone.pdf"),
      },
    ]);
    const refusal = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.result.type === "failed",
        ),
      "the prompt to be refused",
    );
    expect(refusal).toMatchObject({
      result: { type: "failed", error: { code: "attachment_failed", message: expect.stringContaining("ENOENT") } },
    });
    expect(readPrompts()).toEqual([]);
  });
});

describe("tool calls", () => {
  it("maps tool steps to native rows with a stable id across running and completed", async () => {
    process.env.FAKE_SCENARIO = "tool";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "list files");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      callId: calls[1]?.callId,
      name: "run_command",
      status: "running",
      detail: { type: "shell", command: "ls -la", cwd: tempDir },
    });
    expect(calls[1]).toMatchObject({
      status: "completed",
      detail: { type: "shell", command: "ls -la", output: "hello.txt" },
    });
  });

  it("republishes a tool call left running as canceled when the turn is interrupted", async () => {
    process.env.FAKE_SCENARIO = "tool-hang";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "run sleep 30");
    await waitFor(
      () => timelineItems(events).find((item) => item.type === "tool_call"),
      "the tool row to appear",
    );

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls.map((item) => item.status)).toEqual(["running", "canceled"]);
    expect(calls[1]).toMatchObject({ id: calls[0]?.id, error: null });
  });

  it("republishes a tool call left running as failed when the turn fails", async () => {
    process.env.FAKE_SCENARIO = "tool-hang";
    process.env.FAKE_TOOL_END = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "run sleep 30");
    await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls.map((item) => item.status)).toEqual(["running", "failed"]);
    expect(calls[1]).toMatchObject({
      id: calls[0]?.id,
      error: {
        message: "Eligibility check failed: the service is currently unavailable.",
        code: "ERROR",
      },
    });
  });

  it("republishes a tool call left running as failed when the process dies", async () => {
    process.env.FAKE_SCENARIO = "tool-hang";
    process.env.FAKE_TOOL_END = "die";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "run sleep 30");
    await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls.map((item) => item.status)).toEqual(["running", "failed"]);
    expect(calls[1]).toMatchObject({
      id: calls[0]?.id,
      error: { message: expect.stringContaining("closed the connection"), code: "agy_exit" },
    });
  });
});

describe("edit diffs", () => {
  function toolRows(events: ProviderEvent[]) {
    return timelineItems(events).filter((item) => item.type === "tool_call");
  }

  /** The streamed row arrives path-only; the diff lands when both snapshots are read. */
  async function rowWithEditDiff(events: ProviderEvent[]) {
    return waitFor(() => {
      const last = toolRows(events).at(-1);
      return last?.detail.type === "edit" && last.detail.unifiedDiff !== undefined
        ? last
        : undefined;
    }, "the edit row to carry a diff");
  }

  /**
   * The fake holds its rewrite until this file exists, so the consumer has certainly read the
   * file before the tool changes it. No timing guess is involved.
   */
  async function releaseEdit(events: ProviderEvent[], gate: string, name = "replace_file_content") {
    await waitFor(
      () => toolRows(events).find((item) => item.name === name),
      `the ${name} row`,
    );
    writeFileSync(gate, "");
  }

  it("diffs a file the stream only named", async () => {
    process.env.FAKE_SCENARIO = "edit";
    const file = join(tempDir, "hello.txt");
    writeFileSync(file, "hello world\n");
    const gate = join(tempDir, "gate");
    process.env.FAKE_EDIT_FILE = file;
    process.env.FAKE_EDIT_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "change hello to bye");
    await releaseEdit(events, gate);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const diff = (await rowWithEditDiff(events)).detail;
    expect(diff).toMatchObject({
      type: "edit",
      filePath: file,
      unifiedDiff: [
        "--- a/hello.txt",
        "+++ b/hello.txt",
        "@@ -1,1 +1,1 @@",
        "-hello world",
        "+bye world",
      ].join("\n"),
    });

    // The diff republishes the same row rather than adding one: Paseo replaces a row by id.
    const calls = toolRows(events);
    expect(calls.map((item) => item.status)).toEqual(["running", "completed", "completed"]);
    expect(new Set(calls.map((item) => item.id)).size).toBe(1);
    expect(calls[2]).toMatchObject({ id: calls[0]?.id, callId: calls[0]?.callId });
  });

  it("diffs an edit against the content an earlier step showed", async () => {
    // agy applies an edit before its step is deliverable, so the file already holds the new text
    // when the step arrives; only the content a previous step showed can describe the change.
    process.env.FAKE_SCENARIO = "edit-applied";
    const file = join(tempDir, "hello.txt");
    writeFileSync(file, "hello world\n");
    const gate = join(tempDir, "gate");
    process.env.FAKE_EDIT_FILE = file;
    process.env.FAKE_EDIT_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "change hello to bye");
    await releaseEdit(events, gate, "view_file");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const diff = (await rowWithEditDiff(events)).detail;
    expect(diff).toMatchObject({ type: "edit", filePath: file });
    expect(diff.type === "edit" ? diff.unifiedDiff : "").toBe(
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,1 +1,1 @@", "-hello world", "+bye world"].join(
        "\n",
      ),
    );
  });

  it("publishes the content of a file that write_to_file creates", async () => {
    process.env.FAKE_SCENARIO = "edit";
    process.env.FAKE_EDIT_TOOL = "write_to_file";
    process.env.FAKE_EDIT_AFTER = "alpha\n";
    const file = join(tempDir, "notes.txt");
    const gate = join(tempDir, "gate");
    process.env.FAKE_EDIT_FILE = file;
    process.env.FAKE_EDIT_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "create notes.txt");
    await releaseEdit(events, gate, "write_to_file");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const row = await waitFor(() => {
      const last = toolRows(events).at(-1);
      return last?.detail.type === "write" && last.detail.content !== undefined ? last : undefined;
    }, "the write row to carry the new file's content");

    expect(row).toMatchObject({
      status: "completed",
      detail: { type: "write", filePath: file, content: "alpha\n" },
    });
  });

  it("keeps the streamed detail when the file cannot be compared", async () => {
    process.env.FAKE_SCENARIO = "edit";
    // The step reports success without touching the binary file, so neither snapshot is text and
    // no diff can ever be published, whatever the ordering.
    process.env.FAKE_EDIT_SKIP_WRITE = "1";
    const file = join(tempDir, "image.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    process.env.FAKE_EDIT_FILE = file;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "edit the image");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // A second turn is the barrier: a republish for the first would have landed by now.
    await prompt(connection, "and again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn to complete");

    const calls = toolRows(events);
    expect(calls.map((item) => item.status)).toEqual([
      "running",
      "completed",
      "running",
      "completed",
    ]);
    expect(calls[1]?.detail).toEqual({ type: "edit", filePath: file });
  });
});

describe("failures", () => {
  it("fails the turn with the CLI's stderr when the process dies mid-turn", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "agy_exit", message: expect.stringContaining("invalid model selection") },
    });
  });

  it("quotes only the stderr of the process that served the turn", async () => {
    process.env.FAKE_SCENARIO = "fail";
    process.env.FAKE_STDERR_LINE = "error: the first process failed";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello", "m1");
    await waitFor(() => turns(events, "failed")[0], "the first turn to fail");

    process.env.FAKE_STDERR_LINE = "error: the second process failed";
    await prompt(connection, "again", "m2");
    const second = await waitFor(() => turns(events, "failed")[1], "the second turn to fail");

    expect(second).toMatchObject({
      error: { code: "agy_exit", message: expect.stringContaining("second process failed") },
    });
    expect(second).not.toMatchObject({
      error: { message: expect.stringContaining("first process failed") },
    });
  });

  it("fails a turn written to a CLI whose stdin has closed, then recovers on the next one", async () => {
    process.env.FAKE_SCENARIO = "stdin-closed";
    const { connection, events } = await connect();
    await openSession(connection);
    // The CLI closes its stdin before reporting init, so nothing will ever answer this turn.
    await prompt(connection, "stranded", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to report init",
    );

    // The next turn is written into the dead pipe, and refused instead of vanishing.
    await prompt(connection, "refused", "m2");
    const refused = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(refused).toMatchObject({
      error: { code: "agy_launch_failed", message: expect.stringContaining("EPIPE") },
    });

    // A live CLI replaces it on the same conversation: the stranded turn ends with the process it
    // belonged to, and the next turn runs on a fresh process.
    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "recovered", "m3");
    await waitFor(() => turns(events, "completed")[0], "the recovered turn to complete");

    expect(turns(events, "failed")).toHaveLength(2);
    expect(readPrompts().at(-1)).toBe("recovered");
    const argv = readArgv();
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("fails the turn when agy reports an ERROR result", async () => {
    process.env.FAKE_SCENARIO = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "ERROR", message: expect.stringContaining("Eligibility check failed") },
    });
    // Neither an AGY_ERROR line nor an outage marker applies, so the status stands and no
    // retry is suggested.
    expect(turn).not.toMatchObject({ error: { diagnostic: expect.anything() } });
    expect(
      events.some((event) => event.type === "session.notice" && event.notice.id === "agy-unavailable"),
    ).toBe(false);
  });

  it("takes the code and diagnostic from a structured AGY_ERROR line", async () => {
    // agy 1.2.6+ documents this line; no stream-json capture of ours contains one, so the payload
    // is the documented shape (canonical status, short error, retryability, error id).
    process.env.FAKE_SCENARIO = "fail";
    const report = JSON.stringify({
      short_error: "model API request failed",
      status: "UNAVAILABLE",
      code: "503",
      retryable: true,
      error_id: "e-1234",
    });
    process.env.FAKE_STDERR_LINE = `AGY_ERROR: ${report}`;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: {
        code: "UNAVAILABLE",
        message: "model API request failed",
        diagnostic: report,
      },
    });
    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "agy-unavailable",
    );
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
  });

  it("names a captured UNAVAILABLE (code 503) failure and asks for a retry", async () => {
    process.env.FAKE_SCENARIO = "error";
    // Copied from fixtures/05-unavailable.ndjson: a real outage during a turn.
    process.env.FAKE_RESULT_ERROR =
      "failed to send message: send failed; already reported to the user: Eligibility check failed: failed to get load code assist response: UNAVAILABLE (code 503): The service is currently unavailable.";

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "unavailable", message: expect.stringContaining("UNAVAILABLE (code 503)") },
    });
    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "agy-unavailable",
    );
    expect(notice).toMatchObject({
      notice: {
        severity: "warning",
        title: expect.stringContaining("temporarily unavailable"),
        description: expect.stringContaining("Retry"),
      },
    });
  });

  it("names an exhausted AI credits balance and points at another account", async () => {
    // agy 1.2.15 fails at once with this text instead of retrying for minutes. The string is the
    // one in the 1.2.16 binary and changelog; no capture of ours has it, so the result is synthetic.
    process.env.FAKE_SCENARIO = "error";
    process.env.FAKE_RESULT_ERROR = "Your AI credits balance is too low to continue.";

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "credits_exhausted", message: "Your AI credits balance is too low to continue." },
    });
    const notices = events.filter(
      (event) => event.type === "session.notice" && event.notice.id === "agy-credits-exhausted",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      notice: { severity: "warning", description: expect.stringContaining("another Antigravity account") },
    });
    expect(
      events.some((event) => event.type === "session.notice" && event.notice.id === "agy-unavailable"),
    ).toBe(false);
  });

  it("names an exhausted AI credits balance reported as a structured AGY_ERROR status", async () => {
    // INSUFFICIENT_G1_CREDITS_BALANCE is the status string in the 1.2.16 binary; the payload shape
    // is the documented one, as in the UNAVAILABLE case above.
    process.env.FAKE_SCENARIO = "fail";
    const report = JSON.stringify({
      short_error: "inference failed",
      status: "INSUFFICIENT_G1_CREDITS_BALANCE",
      retryable: false,
    });
    process.env.FAKE_STDERR_LINE = `AGY_ERROR: ${report}`;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "credits_exhausted", message: "inference failed", diagnostic: report },
    });
    expect(
      events.some((event) => event.type === "session.notice" && event.notice.id === "agy-credits-exhausted"),
    ).toBe(true);
  });

  it("cancels the running turn on interrupt and lets the session continue", async () => {
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "count forever");
    // Wait for `init` so the CLI has actually started before it is signalled.
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    const canceled = await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
    expect(canceled).toMatchObject({ error: { message: "Interrupted" } });
    expect(events.some((event) => event.type === "request.completed" && event.requestId === "i1")).toBe(true);

    // A second prompt must start a fresh process on the same conversation.
    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "hello again", "m2");
    await waitFor(() => turns(events, "completed")[0], "the follow-up turn to complete");
    expect(readArgv()).toContain("--conversation");
  });

  it("rejects prompts for unknown sessions and duplicate opens", async () => {
    const { connection } = await connect();
    await openSession(connection);

    await expect(openSession(connection)).rejects.toThrow("Session already exists");
    await expect(prompt(connection, "hi", "m1", "missing")).rejects.toThrow("Unknown session");
  });

  it("rejects every send once the connection is closed", async () => {
    const { connection } = await connect();
    await openSession(connection);
    await connection.close();

    await expect(prompt(connection, "hi")).rejects.toThrow("connection is closed");
    await expect(
      connection.send({ type: "catalog", requestId: "c1" } as ProviderInput),
    ).rejects.toThrow("connection is closed");
  });
});

describe("session.configure", () => {
  it("applies a model change by restarting with the same conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { model: "gemini-3.7-flash-low" },
    } as ProviderInput);

    const configs = events.filter((event) => event.type === "session.config");
    expect(configs.at(-1)).toMatchObject({ config: { model: "gemini-3.7-flash-low" } });
    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === "cfg-1"),
    ).toBe(true);

    await prompt(connection, "second", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.7-flash-low");
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("defers a model change instead of aborting the running turn", async () => {
    // The fake stays silent in this scenario, so the turn is still running when configure arrives.
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { model: "gemini-3.7-flash-low" },
    } as ProviderInput);

    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === "cfg-1"),
    ).toBe(true);
    // Switching a selector must never kill an answer that is already in flight.
    expect(turns(events, "failed")).toHaveLength(0);
    expect(turns(events, "canceled")).toHaveLength(0);

    // Finish the turn, then confirm the change lands on the next spawn.
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");

    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "next", "m2");
    await waitFor(() => turns(events, "completed")[0], "the next turn");

    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.7-flash-low");
    expect(argv).toContain("--conversation");
  });
});

describe("history replay", () => {
  const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

  /** Opens a second connection on the same conversation with `history: "replay"`. */
  async function replay(conversationId = CONVERSATION_ID): Promise<ProviderEvent[]> {
    const replayed = await createProvider().connect({ versions: [1], capabilities: OFFERED });
    openConnections.push(replayed);
    const events = watchConnection(replayed);
    await replayed.send({
      type: "session.open",
      requestId: "open-replay",
      sessionId: "session-replay",
      config: sessionConfig(),
      history: "replay",
      persistence: { version: 1, data: { conversationId } },
    } as ProviderInput);
    return events;
  }

  it("republishes stored rows for a resumed conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );

    const replayEvents = await replay();
    const replayedItems = timelineItems(replayEvents);
    // The user message is published before agy starts, so this also guards the buffering path.
    expect(replayedItems.some((item) => item.type === "user_message" && item.text === "hello")).toBe(true);
    expect(replayedItems.some((item) => item.type === "assistant_message")).toBe(true);

    // Replay must arrive before the session is announced ready.
    const readyIndex = replayEvents.findIndex((event) => event.type === "session.ready");
    const firstTimelineIndex = replayEvents.findIndex((event) => event.type === "timeline.item");
    expect(firstTimelineIndex).toBeGreaterThanOrEqual(0);
    expect(firstTimelineIndex).toBeLessThan(readyIndex);
  });

  it("flushes the last answer when the connection closes", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");

    // Closing lands inside the write debounce window, where the answer still lives in memory.
    await connection.close();

    const replayed = timelineItems(await replay());
    expect(replayed.filter((item) => item.type === "assistant_message").at(-1)).toMatchObject({
      text: "echo:hello\n",
    });
  });

  it("stores nothing for a session that is not persisted", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { persist: false });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );

    const transcripts = join(
      process.env.PASEO_HOME ?? "",
      "plugin-data",
      "antigravity-cli",
      "transcripts",
    );
    expect(existsSync(transcripts) ? readdirSync(transcripts) : []).toEqual([]);
    expect(timelineItems(await replay())).toEqual([]);
  });
});

describe("session import", () => {
  const IMPORTED_ID = "61d5201e-47e0-405e-9cd3-2264e8b5d740";

  /** Points HOME at a temp home holding an agy-shaped conversation index. */
  function seedConversations(): void {
    const home = join(tempDir, "home");
    process.env.HOME = home;
    writeConversationDb(home, [
      {
        conversationId: IMPORTED_ID,
        title: "Replace Word In File",
        preview: "In hello.txt change the word hello to bye.",
        lastModifiedTime: "2026-09-23 15:45:49.636929+00:00",
        workspacePaths: [tempDir],
      },
      {
        conversationId: "99999999-9999-9999-9999-999999999999",
        title: "Another workspace",
        preview: "Not this one",
        lastModifiedTime: "2026-09-23 16:00:00+00:00",
        workspacePaths: [join(tempDir, "elsewhere")],
      },
    ]);
  }

  async function list(
    connection: ProviderConnection,
    events: ProviderEvent[],
  ): Promise<Extract<ProviderEvent, { type: "sessions" }>> {
    await connection.send({ type: "sessions", requestId: "list-1", cwd: tempDir } as ProviderInput);
    return waitFor(
      () => events.find((event): event is Extract<ProviderEvent, { type: "sessions" }> => event.type === "sessions"),
      "the session list",
    );
  }

  it("lists Antigravity's own conversations for the requested workspace", async () => {
    seedConversations();
    const { connection, events } = await connect();
    await openSession(connection);

    expect(await list(connection, events)).toMatchObject({
      requestId: "list-1",
      sessions: [
        {
          persistence: { version: 1, data: { conversationId: IMPORTED_ID } },
          cwd: tempDir,
          title: "Replace Word In File",
          description: "In hello.txt change the word hello to bye.",
          updatedAt: "2026-09-23T15:45:49.636Z",
        },
      ],
    });
  });

  it("resumes an imported conversation and says its history is not replayed", async () => {
    seedConversations();
    const { connection, events } = await connect();
    await openSession(connection);
    const listed = await list(connection, events);
    expect(listed.sessions).toHaveLength(1);

    await openSession(connection, {}, {
      sessionId: "imported",
      history: "replay",
      persistence: listed.sessions[0]?.persistence,
    });

    // The plugin has no timeline for this conversation, and says so once.
    const notices = events.filter(
      (event) => event.type === "session.notice" && event.notice.id === "history-unavailable",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      sessionId: "imported",
      notice: { severity: "info", title: "Earlier history is not shown" },
    });
    expect(timelineItems(events)).toEqual([]);

    // The next prompt continues the imported conversation in Antigravity.
    await prompt(connection, "carry on", "m1", "imported");
    await waitFor(() => turns(events, "completed", "imported")[0], "the imported turn");
    const argv = readArgv();
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(IMPORTED_ID);
  });

  it("says nothing about replay for a conversation this plugin stored itself", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );

    await openSession(connection, {}, {
      sessionId: "resumed",
      history: "replay",
      persistence: {
        version: 1,
        data: { conversationId: "11111111-2222-3333-4444-555555555555" },
      },
    });

    expect(
      events.filter((event) => event.type === "session.notice" && event.notice.id === "history-unavailable"),
    ).toEqual([]);
    expect(timelineItems(events).some((item) => item.type === "assistant_message")).toBe(true);
  });
});

describe("slash commands", () => {
  /** A command prompt, as Paseo sends one for a name in the published command list. */
  async function commandPrompt(
    connection: ProviderConnection,
    name: string,
    args: string,
    clientMessageId = "c1",
  ): Promise<void> {
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "command", name, arguments: args },
      },
    } as ProviderInput);
  }

  function commands(events: ProviderEvent[]): Extract<ProviderEvent, { type: "session.commands" }>[] {
    return events.flatMap((event) => (event.type === "session.commands" ? [event] : []));
  }

  /**
   * A skill in `~/.agents/skills`, the shared installer's directory, which the CLI never reads:
   * only this plugin expands it. `HOME` is repointed before the session opens, because that is
   * when the list the composer picks from is filled.
   */
  function sharedSkill(name: string, body: string): { dir: string; path: string } {
    const dir = join(tempDir, "home", ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, `---\nname: ${name}\ndescription: A shared skill\n---\n\n${body}`, "utf8");
    process.env.HOME = join(tempDir, "home");
    return { dir, path };
  }

  /** The `--add-dir` values of one launch, in argv order. */
  function addDirsOf(argv: string[]): string[] {
    return argv.flatMap((arg, index) => (arg === "--add-dir" ? [argv[index + 1] ?? ""] : []));
  }

  it("publishes the commands before the session is ready", async () => {
    // A temp HOME keeps the CLI's own plugin and built-in skills out of the expected list.
    const home = join(tempDir, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    mkdirSync(join(tempDir, ".agents", "skills", "release-notes"), { recursive: true });
    writeFileSync(
      join(tempDir, ".agents", "skills", "release-notes", "SKILL.md"),
      "---\nname: release-notes\ndescription: Draft the release notes\n---\n\nSteps.\n",
      "utf8",
    );

    const { connection, events } = await connect();
    await openSession(connection);

    const published = commands(events);
    expect(published).toHaveLength(1);
    expect(published[0]?.commands).toEqual([
      { name: "plan", description: expect.any(String) },
      { name: "goal", description: expect.any(String) },
      { name: "grill-me", description: expect.any(String) },
      { name: "teamwork-preview", description: expect.any(String) },
      { name: "learn", description: expect.any(String) },
      { name: "schedule", description: expect.any(String) },
      { name: "boost", description: expect.any(String) },
      { name: "browser", description: expect.any(String) },
      { name: "release-notes", description: "Draft the release notes" },
    ]);
    // Paseo fills the draft composer's picker only from what arrived before `session.ready`.
    const ready = events.findIndex((event) => event.type === "session.ready");
    expect(events.findIndex((event) => event.type === "session.commands")).toBeLessThan(ready);
  });

  it("serves a command on a process launched for it, then relaunches for plain turns", async () => {
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "goal", "say ok");
    await waitFor(() => turns(events, "completed")[0], "the command turn to complete");

    // The command reaches the CLI as the first token of the turn, which is what expands it, and
    // the process carrying it must not disable expansion.
    expect(readPrompts()).toEqual(["/goal say ok"]);
    const [commandLaunch] = readArgvLog();
    expect(commandLaunch).not.toContain("--disable-slash-commands");

    // A plain message that starts with `/` goes out exactly as typed: Paseo only sends a command
    // input for a name it publishes, and this one would fail the turn if the CLI expanded it.
    await prompt(connection, "/skills reload", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn to complete");

    const launches = readArgvLog();
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain("--disable-slash-commands");
    expect(launches[1]?.[launches[1].indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(readPrompts()).toEqual(["/goal say ok", "/skills reload"]);

    // A second command reuses the expansion process rather than restarting again.
    await commandPrompt(connection, "grill-me", "say ok", "c3");
    await waitFor(() => turns(events, "completed")[2], "the second command turn to complete");
    expect(readArgvLog()).toHaveLength(3);
    expect(readArgvLog()[2]).not.toContain("--disable-slash-commands");
    expect(readPrompts()).toEqual(["/goal say ok", "/skills reload", "/grill-me say ok"]);
  });

  it("never prepends the system prompt in front of a command", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });

    await commandPrompt(connection, "goal", "say ok");
    await waitFor(() => turns(events, "completed")[0], "the command turn to complete");
    // The preamble would push `/goal` out of the first-token position, where the CLI stops
    // expanding it, so it waits for the first message instead.
    expect(readPrompts()).toEqual(["/goal say ok"]);

    await prompt(connection, "hello", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn to complete");
    expect(readPrompts()[1]).toBe("<system_instructions>\nBe terse.\n</system_instructions>\n\nhello");
  });

  it("refuses a command while a turn is running", async () => {
    // This scenario stays silent, so the first turn is still running when the command arrives.
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await commandPrompt(connection, "goal", "say ok", "c2");
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "c2" &&
            event.result.type === "failed",
        ),
      "the command to be refused",
    );
    expect(refusal).toMatchObject({
      result: { type: "failed", error: { code: "busy", message: expect.stringContaining("slash") } },
    });

    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the running turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["long task"]);
    expect(readArgvLog()).toHaveLength(1);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("expands a shared-installer skill itself, without ever sending a slash name", async () => {
    const { dir } = sharedSkill("release-notes", "List the merged pull requests.");
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "release-notes", "for v1.2");
    await waitFor(() => turns(events, "completed")[0], "the skill turn to complete");

    // The skill's own instructions are the prompt, and the CLI must keep expansion off: nothing in
    // a skill body may be read as a command. The directory line is what makes its assets reachable.
    expect(readPrompts()).toEqual([
      `[Skill: release-notes]\nList the merged pull requests.\n\nSkill directory: ${dir} — resolve relative paths in these instructions against it.\n\nUser request: for v1.2`,
    ]);
    const [launch] = readArgvLog();
    expect(launch).toContain("--disable-slash-commands");
    expect(addDirsOf(launch ?? [])).toContain(dir);
    // The timeline still reads the command that was picked, which is what Paseo matches its own
    // optimistic row against — by `clientMessageId`, and by the text it showed.
    const rows = timelineItems(events).filter((item) => item.type === "user_message");
    expect(rows.at(-1)?.text).toBe("/release-notes for v1.2");
  });

  it("takes the skill directory away again for the next plain turn", async () => {
    const { dir } = sharedSkill("release-notes", "List the merged pull requests.");
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "release-notes", "for v1.2");
    await waitFor(() => turns(events, "completed")[0], "the skill turn to complete");
    await prompt(connection, "hello", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn to complete");

    const launches = readArgvLog();
    expect(addDirsOf(launches[0] ?? [])).toContain(dir);
    expect(addDirsOf(launches[1] ?? [])).not.toContain(dir);
    expect(launches[1]).toContain("--disable-slash-commands");
  });

  it("fails a skill that is gone by the time its command runs", async () => {
    const { path } = sharedSkill("release-notes", "List the merged pull requests.");
    const { connection, events } = await connect();
    await openSession(connection);
    rmSync(path);

    await commandPrompt(connection, "release-notes", "for v1.2");
    const failed = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "c1",
        ),
      "the skill prompt to fail",
    );
    expect(failed).toMatchObject({
      result: {
        type: "failed",
        error: { code: "skill_unavailable", message: expect.stringContaining("release-notes") },
      },
    });
    // A turn that never started launches nothing, and sends nothing.
    expect(readArgvLog()).toEqual([]);
    expect(readPrompts()).toEqual([]);
  });

  it("fails a skill too large to send", async () => {
    sharedSkill("huge-skill", "x".repeat(70 * 1024));
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "huge-skill", "go");
    const failed = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "c1",
        ),
      "the oversized skill to fail",
    );
    expect(failed).toMatchObject({
      result: {
        type: "failed",
        error: { code: "skill_too_large", message: expect.stringContaining("64 KiB") },
      },
    });
    expect(readArgvLog()).toEqual([]);
  });

  it("refuses a skill while a turn is running", async () => {
    sharedSkill("release-notes", "List the merged pull requests.");
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    // The skill needs its own `--add-dir`, and the CLI cannot be replaced while it owes a turn.
    await commandPrompt(connection, "release-notes", "for v1.2", "c2");
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "c2" &&
            event.result.type === "failed",
        ),
      "the skill to be refused",
    );
    expect(refusal).toMatchObject({
      result: { type: "failed", error: { code: "busy", message: expect.stringContaining("skill's own directory") } },
    });
    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the running turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["long task"]);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("refuses a plain prompt while a skill turn is running", async () => {
    sharedSkill("release-notes", "List the merged pull requests.");
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await commandPrompt(connection, "release-notes", "for v1.2", "c1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    // The running CLI carries the skill's directory, so the next turn's launch would differ; the
    // prompt is refused rather than queued into a process that cannot be replaced yet.
    await prompt(connection, "second", "m2");
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "m2" &&
            event.result.type === "failed",
        ),
      "the plain prompt to be refused",
    );
    expect(refusal).toMatchObject({
      result: {
        type: "failed",
        error: { code: "busy", message: expect.stringContaining("extra skill directory") },
      },
    });

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("refuses a plain prompt while a command turn is running", async () => {
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await commandPrompt(connection, "goal", "say ok", "c1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await prompt(connection, "second", "m2");
    // The running CLI has expansion on, so a plain message that happens to start with `/` would be
    // expanded instead of answered; the prompt is refused rather than queued into it.
    const answer = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "m2",
        ),
      "the plain prompt to be answered",
    );
    expect(answer).toMatchObject({
      result: {
        type: "failed",
        error: { code: "busy", message: expect.stringContaining("slash command") },
      },
    });

    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the command turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["/goal say ok"]);
    expect(readArgvLog()).toHaveLength(1);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });
});

describe("subagents", () => {
  /** The child conversations the fake's `subagent` scenario runs, in the order it names them. */
  const CHILD_A = "aaaaaaaa-0000-4000-8000-000000000000";
  const CHILD_B = "aaaaaaaa-0000-4000-8000-000000000001";
  const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";
  /** The 1.2.11 capture of a `Workspace: branch` child, which is what says where it worked. */
  const WORKTREE_FIXTURE = fileURLToPath(
    new URL("../fixtures/14-subagent-worktree.ndjson", import.meta.url),
  );
  const WORKTREE_CHILD = "380c78c8-98c8-4e89-967e-71f4ed2aa746";
  const WORKTREE_PARENT = "72c3ee5b-91e9-448f-a04f-f227aead682f";

  type ToolRow = Extract<ProviderTimelineItem, { type: "tool_call" }>;
  type OpenedSession = Extract<ProviderEvent, { type: "session.opened" }>;
  interface ReportedChild {
    index?: number;
    conversationId?: string;
    logUri?: string;
    typeName?: string;
    role?: string;
    prompt?: string;
    done?: boolean;
  }

  /**
   * Points HOME at a temp home: the fake writes each child's transcript under
   * `$HOME/.gemini/antigravity-cli/brain/<child conversation>/…`, which is where `log_uri` points.
   */
  function tempHome(): void {
    const home = join(tempDir, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
  }

  /**
   * An `agy` that replays a captured run instead of inventing one: every line of the fixture goes
   * to stdout once the turn arrives, with the recorded paths rewritten to this test's temp
   * directory. The `subagent` scenario of `testing/fake-agy.mjs` cannot stand in here — it reports
   * the parent's own directory as the child's workspace, which is exactly what a `Workspace:
   * branch` child does not do — so the capture itself has to be the stream.
   */
  function replayAgy(fixture: string, replacements: ReadonlyArray<readonly [string, string]>): string {
    const path = join(tempDir, "replay-agy.mjs");
    writeFileSync(
      path,
      [
        "#!/usr/bin/env node",
        'import { readFileSync } from "node:fs";',
        `const lines = readFileSync(${JSON.stringify(fixture)}, "utf8").split("\\n");`,
        `const from = ${JSON.stringify(replacements.map(([recorded]) => recorded))};`,
        `const to = ${JSON.stringify(replacements.map(([, rewritten]) => rewritten))};`,
        'process.stdin.setEncoding("utf8");',
        'process.stdin.once("data", () => {',
        "  for (const line of lines) {",
        '    if (line.trim().length === 0) continue;',
        "    let out = line;",
        "    from.forEach((needle, index) => {",
        "      out = out.split(needle).join(to[index]);",
        "    });",
        "    process.stdout.write(`${out}\\n`);",
        "  }",
        "});",
        // The plugin keeps writing turns to stdin; the process stays up to take them, as agy does.
        "process.stdin.resume();",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path, 0o755);
    return path;
  }

  /** A child transcript that says one thing and ends: enough for its own session to open. */
  function childTranscript(cwd: string): string {
    return [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "<USER_REQUEST>\nRun pwd.\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: `I am working in ${cwd}.`,
        tool_calls: [],
      }),
      "",
    ].join("\n");
  }

  function subagentRows(events: ProviderEvent[]): ToolRow[] {
    return timelineItems(events).filter(
      (item): item is ToolRow => item.type === "tool_call" && item.detail.type === "sub_agent",
    );
  }

  /**
   * A file a child works on. The fake names it under its own `process.cwd()`, which is resolved —
   * on macOS `/var` is a symlink to `/private/var`, and the CLI's cwd is the resolved path while
   * the test's temp dir is the one it asked for.
   */
  function childFile(index: number): string {
    return `${realpathSync(tempDir)}/subagent-${index}.txt`;
  }

  function reported(row: ToolRow): ReportedChild {
    return (row.metadata?.subagent ?? {}) as ReportedChild;
  }

  /** The child session of one subagent row, as the row links to it. */
  function childIdOf(events: ProviderEvent[], conversationId = CHILD_A): string {
    return `session-1:subagent:${conversationId}`;
  }

  function childSessions(events: ProviderEvent[]): OpenedSession[] {
    return events.filter(
      (event): event is OpenedSession =>
        event.type === "session.opened" && event.parentSessionId !== undefined,
    );
  }

  function itemsFor(events: ProviderEvent[], sessionId: string): ProviderTimelineItem[] {
    return events.flatMap((event) =>
      event.type === "timeline.item" && event.sessionId === sessionId ? [event.item] : [],
    );
  }

  /** Every `session.closed` a test saw, with the error it carried when it carried one. */
  function closedSessions(
    events: ProviderEvent[],
    sessionId?: string,
  ): Array<{ sessionId: string; error?: ProviderError }> {
    return events.flatMap((event) =>
      event.type === "session.closed" && (sessionId === undefined || event.sessionId === sessionId)
        ? [{ sessionId: event.sessionId, ...(event.error ? { error: event.error } : {}) }]
        : [],
    );
  }

  /** Where one child's own terminal turn sits among the events, or -1. */
  function turnIndex(events: ProviderEvent[], sessionId: string, state: string): number {
    return events.findIndex(
      (event) => event.type === "session.turn" && event.sessionId === sessionId && event.state === state,
    );
  }

  function childEvents(events: ProviderEvent[], sessionId: string): ProviderEvent[] {
    return events.filter(
      (event) =>
        (event.type === "timeline.item" || event.type === "session.turn") &&
        event.sessionId === sessionId,
    );
  }

  /** The file a child's `log_uri` names, which is what a test appends to behind the plugin's back. */
  function childTranscriptFile(events: ProviderEvent[], conversationId = CHILD_A): string {
    const uri = subagentRows(events)
      .filter((row) => reported(row).conversationId === conversationId)
      .map((row) => reported(row).logUri)
      .find((value) => value !== undefined);
    if (uri === undefined) throw new Error("no child transcript was reported");
    return fileURLToPath(uri);
  }

  /** A last word for a child whose transcript a test finishes by hand. */
  function finalChildLine(stepIndex: number): string {
    return (
      JSON.stringify({
        step_index: stepIndex,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-09-23T19:49:42Z",
        content: "I have read the file and reported its contents back to the parent agent.",
      }) + "\n"
    );
  }

  /**
   * A line the child's transcript already holds. Appending it moves the file without moving any
   * row: the step index it repeats replaces the line that was there, with the same content.
   */
  function repeatedChildLine(): string {
    return (
      JSON.stringify({
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-09-23T19:49:34Z",
        content: `Message sent to "${CONVERSATION_ID}".`,
      }) + "\n"
    );
  }

  async function startedTurn(text = "spawn a researcher"): Promise<Harness> {
    process.env.FAKE_SCENARIO = "subagent";
    tempHome();
    const harness = await connect();
    await openSession(harness.connection);
    await prompt(harness.connection, text);
    return harness;
  }

  /**
   * Waits out one poll of the transcript tailer and a little more, for the two tests that assert
   * *nothing* arrives. Real time is the point: the plugin follows a file on a real 500 ms interval
   * with `fs.watch` events from the OS, and the writer is a separate process, so no fake clock in
   * this process can drive the thing whose silence is being checked.
   */
  async function waitOutAPoll(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 800);
    await promise;
  }

  it("follows a capture of a branch child in the worktree agy gave it", async () => {
    tempHome();
    const home = process.env.HOME ?? "";
    const worktree = join(
      tempDir,
      "worktrees",
      WORKTREE_PARENT,
      "subagent-Branch-Worker-self-13808e26",
    );
    mkdirSync(worktree, { recursive: true });
    // The child's own transcript, where the capture's `log_uri` points once rewritten: without it
    // the child never says anything, and a session that never says anything never opens.
    const transcript = join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      WORKTREE_CHILD,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, childTranscript(worktree), "utf8");

    const { connection, events } = await connect();
    await openSession(connection, {
      providerOptions: {
        agyPath: replayAgy(WORKTREE_FIXTURE, [
          ["/Users/dev/.gemini/antigravity-cli/worktrees", join(tempDir, "worktrees")],
          ["/Users/dev/.gemini/antigravity-cli/brain", join(home, ".gemini", "antigravity-cli", "brain")],
        ]),
      },
    });
    await prompt(connection, "branch a worker", "m1");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // The capture reports the worktree agy created for the child as a `file://` URI, and that is
    // where the child's session has to say it works — not the parent's workspace.
    const opened = await waitFor(() => childSessions(events)[0], "the child session to open");
    expect(opened.cwd).toBe(worktree);
    expect(childSessions(events)).toHaveLength(1);
  });

  it("publishes a row per child, from its prompt first and then from its conversation", async () => {
    const { events } = await startedTurn();
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const rows = subagentRows(events);
    // The tool line names the children the model asked for, before any of them exists.
    expect(rows[0]).toMatchObject({
      name: "invoke_subagent",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "research",
        description: "Researcher A",
        log: `Please read the file ${childFile(0)} and report its exact contents.`,
      },
    });
    expect(reported(rows[0]!)).toMatchObject({
      index: 0,
      typeName: "research",
      role: "Researcher A",
      prompt: `Please read the file ${childFile(0)} and report its exact contents.`,
    });
    // Neither the conversation nor the outcome is known when the call is made.
    expect(reported(rows[0]!).conversationId).toBeUndefined();
    expect(reported(rows[0]!).done).toBeUndefined();

    // The subagent line of the same step fills in the conversation, and the child's own report
    // settles the row: one row throughout, from the call that spawned it to what it answered.
    // A child's transcript directory usually does not exist yet when its follow starts, so the
    // tailer reaches the first line on its next tick — which can be after this turn has ended. The
    // row is therefore taken once it carries the report, not whenever the turn happens to finish.
    // `childSessionId` arrives with the subagent tool line; `done` only with the report that
    // follows it, so the wait has to ask for the same settled row the assertions below read.
    const withReport = await waitFor(() => {
      const last = subagentRows(events)
        .filter((row) => row.id === rows[0]?.id)
        .at(-1);
      if (last?.detail.type !== "sub_agent" || last.detail.childSessionId === undefined) {
        return undefined;
      }
      return reported(last).done === true ? last : undefined;
    }, "the child's report to reach the row");
    expect(withReport).toMatchObject({
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "research",
        description: "Researcher A",
        childSessionId: childIdOf(events),
        log: `The file \`${childFile(0)}\` contains:\n\n\`\`\`\nalpha\n\`\`\``,
        actions: [
          { index: 1, toolName: "view_file", summary: "Read subagent-0.txt" },
          { index: 2, toolName: "send_message", summary: "Report subagent-0.txt" },
        ],
      },
    });
    expect(reported(withReport)).toMatchObject({
      conversationId: CHILD_A,
      logUri: expect.stringMatching(/^file:/),
      done: true,
    });

    // The parent's own answer is untouched by any of it: no child text lands on its session, and
    // the two things it said are exactly what Paseo holds for the ids they streamed under.
    const parentEvents = events.filter(
      (event) => event.type !== "timeline.item" || event.sessionId === "session-1",
    );
    expect([...paseoView(parentEvents).messages.values()]).toEqual([
      "I have dispatched the research subagents to read their files.\n",
      "Here are the contents reported by each subagent:\n",
    ]);
  });

  it("opens the child's session linked to the row, able to host its own subagents", async () => {
    const { connection, events } = await startedTurn();
    const childId = childIdOf(events);
    const opened = await waitFor(
      () => childSessions(events).find((event) => event.sessionId === childId),
      "the child session to open",
    );

    expect(opened).toMatchObject({
      parentSessionId: "session-1",
      toolCallId: subagentRows(events)[0]?.id,
      capabilities: ["session.subsession"],
      restoration: "parent",
      title: "Researcher A",
      description: `Please read the file ${childFile(0)} and report its exact contents.`,
      // The directory the child's workspace URI names — resolved, like `childFile`: the CLI's own
      // cwd is the resolved temp path, and the fake reports that back as the URI.
      cwd: realpathSync(tempDir),
    });
    // Nothing is pumped into a child: Paseo cannot address it, which is what the empty capability
    // list means, and the provider agrees.
    await expect(prompt(connection, "hello", "m2", childId)).rejects.toThrow("Unknown session");
  });

  it("gives the child its own rows, its own turn, and the answer it actually gave", async () => {
    const { events } = await startedTurn();
    const childId = childIdOf(events);
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "session.turn" && event.sessionId === childId && event.state === "completed",
        )
          ? true
          : undefined,
      "the child's turn to complete",
    );

    const childItems = itemsFor(events, childId);
    expect(childItems.map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
    expect(childItems[0]).toMatchObject({
      text: `Please read the file ${childFile(0)} and report its exact contents.`,
    });
    expect(childItems[1]).toMatchObject({
      name: "view_file",
      status: "completed",
      detail: { type: "read", filePath: childFile(0) },
    });
    expect(childItems[2]).toMatchObject({ name: "send_message", status: "completed" });
    expect(
      events.filter((event) => event.type === "session.turn" && event.sessionId === childId),
    ).toMatchObject([
      { turnId: `agy-sub:${CHILD_A}`, state: "started" },
      { turnId: `agy-sub:${CHILD_A}`, state: "completed" },
    ]);
    // Paseo maps every assistant snapshot to a delta, so the child's rows must end at exactly the
    // text the child answered with — republished as it is, not appended to.
    expect(paseoView(childEvents(events, childId)).finalText).toBe(
      `I have read ${childFile(0)} and reported its contents back to the parent agent.`,
    );

    // Its own turn ends, and its session closes with it: the host counts a child that is not
    // closed as still live, and reports every live session as failed on the next reload.
    expect(closedSessions(events, childId)).toEqual([{ sessionId: childId }]);
    expect(
      events.findIndex((event) => event.type === "session.closed" && event.sessionId === childId),
    ).toBeGreaterThan(turnIndex(events, childId, "completed"));
  });

  it("follows every child of one call, each with its own row and session", async () => {
    process.env.FAKE_SUBAGENT_COUNT = "2";
    const { events } = await startedTurn();
    await waitFor(
      () => (childSessions(events).length === 2 ? true : undefined),
      "both children to open",
    );
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const byId = new Map(subagentRows(events).map((row) => [row.id, row]));
    expect(byId.size).toBe(2);
    expect([...byId.values()].map((row) => row.status)).toEqual(["completed", "completed"]);
    expect([...byId.values()].map((row) => [reported(row).index, reported(row).role])).toEqual([
      [0, "Researcher A"],
      [1, "Researcher B"],
    ]);
    expect(childSessions(events).map((event) => event.sessionId).sort()).toEqual(
      [childIdOf(events, CHILD_A), childIdOf(events, CHILD_B)].sort(),
    );
    expect(itemsFor(events, childIdOf(events, CHILD_B)).map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
  });

  it("falls back to the row the stream justified when a child's transcript is unreadable", async () => {
    process.env.FAKE_SUBAGENT_TRANSCRIPT = "malformed";
    const { events } = await startedTurn();
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // The turn is what settles the row; nothing is claimed about the child, and no session opens.
    const settled = subagentRows(events).at(-1);
    expect(settled).toMatchObject({ status: "completed", error: null });
    expect(reported(settled!)).toMatchObject({ conversationId: CHILD_A });
    expect(reported(settled!).done).toBeUndefined();
    expect(childSessions(events)).toEqual([]);
  });

  it("falls back to the row the stream justified when a child writes no transcript", async () => {
    process.env.FAKE_SUBAGENT_TRANSCRIPT = "missing";
    const { events } = await startedTurn();
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(subagentRows(events).at(-1)).toMatchObject({ status: "completed", error: null });
    expect(childSessions(events)).toEqual([]);
  });

  it("fails the row of a child that stopped on an error, though the parent's turn succeeded", async () => {
    // agy 1.3.1 reports such a child (out of quota, out of model capacity) as `Error: <reason>`
    // rather than done; the parent summing the failure up gracefully must not make it a success.
    process.env.FAKE_SUBAGENT_TRANSCRIPT = "error";
    const { events } = await startedTurn();
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const failed = await waitFor(() => {
      const row = subagentRows(events).at(-1);
      return row?.status === "failed" ? row : undefined;
    }, "the subagent row to fail");
    expect(failed.error).toEqual({ message: "RESOURCE_EXHAUSTED: quota exceeded" });
    expect(reported(failed).done).toBeUndefined();
  });

  it("settles a child that moves past the error it stopped on as completed", async () => {
    process.env.FAKE_SUBAGENT_TRANSCRIPT = "error";
    const { events } = await startedTurn();
    await waitFor(() => (subagentRows(events).at(-1)?.status === "failed" ? true : undefined), "the row to fail");

    // The error lasts only until the child makes progress, as in agy's own `/agents`.
    appendFileSync(childTranscriptFile(events), finalChildLine(6), "utf8");
    const childId = childIdOf(events);
    await waitFor(
      () => (turnIndex(events, childId, "completed") >= 0 ? true : undefined),
      "the child's turn to complete",
    );
    expect(subagentRows(events).at(-1)).toMatchObject({ status: "completed", error: null });
  });

  it("ignores a step type it does not know and still finishes the child", async () => {
    process.env.FAKE_SUBAGENT_TRANSCRIPT = "unknown-type";
    const { events } = await startedTurn();
    const childId = childIdOf(events);
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "session.turn" && event.sessionId === childId && event.state === "completed",
        )
          ? true
          : undefined,
      "the child's turn to complete",
    );

    // The line nothing knows contributes no row, and the child's own last word still settles it.
    expect(itemsFor(events, childId).map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
    expect(subagentRows(events).at(-1)).toMatchObject({
      status: "completed",
      detail: { childSessionId: childId },
    });
  });

  it("opens a subagent that a subagent started under that subagent, and holds it open until then", async () => {
    // The first child starts a subagent of its own, which only its own transcript reports. The
    // gate holds that grandchild's last word back, so the child speaks while it still runs.
    const GRANDCHILD = "bbbbbbbb-0000-4000-8000-000000000000";
    const nestedGate = join(tempDir, "nested-gate");
    process.env.FAKE_SUBAGENT_NESTED = "1";
    process.env.FAKE_SUBAGENT_NESTED_GATE = nestedGate;
    const { events } = await startedTurn();
    const childId = childIdOf(events);
    const grandchildId = `session-1:subagent:${GRANDCHILD}`;
    const spawnRowId = `agy-sub:${CHILD_A}:5:spawn:0:0`;

    // Linked to the row in the child's timeline, and under the child rather than the conversation.
    const opened = await waitFor(
      () => childSessions(events).find((event) => event.sessionId === grandchildId),
      "the nested subagent's session to open",
    );
    expect(opened).toMatchObject({
      parentSessionId: childId,
      toolCallId: spawnRowId,
      capabilities: ["session.subsession"],
      restoration: "parent",
      title: "Nested Worker",
      description: "Summarise what you find.",
    });
    const row = await waitFor(
      () =>
        itemsFor(events, childId)
          .filter((item) => item.id === spawnRowId)
          .find((item) => item.type === "tool_call" && item.detail.type === "sub_agent" && item.detail.childSessionId === grandchildId),
      "the nested subagent's row to link its session",
    );
    expect(row).toMatchObject({ name: "invoke_subagent", status: "running" });
    // One row for the call, not a row for the call and another for the subagent it started.
    expect(
      new Set(
        itemsFor(events, childId).flatMap((item) =>
          item.type === "tool_call" && item.name === "invoke_subagent" ? [item.id] : [],
        ),
      ),
    ).toEqual(new Set([spawnRowId]));

    // The child said its last word, but its subagent is still going: the child is waiting on it,
    // so neither its turn nor its row is over and its session stays open.
    await waitFor(
      () =>
        itemsFor(events, childId).some(
          (item) => item.type === "assistant_message" && item.text.startsWith("I have read"),
        )
          ? true
          : undefined,
      "the child's last word",
    );
    await waitOutAPoll();
    expect(turnIndex(events, childId, "completed")).toBe(-1);
    expect(closedSessions(events, childId)).toEqual([]);
    expect(subagentRows(events).filter((row) => row.id === subagentRows(events)[0]?.id).at(-1)).toMatchObject({
      status: "running",
    });

    writeFileSync(nestedGate, "", "utf8");
    await waitFor(
      () => (closedSessions(events, childId).length > 0 ? true : undefined),
      "the child's session to close",
    );
    expect(turnIndex(events, grandchildId, "completed")).toBeGreaterThan(-1);
    expect(closedSessions(events, grandchildId)).toEqual([{ sessionId: grandchildId }]);
    expect(closedSessions(events, childId)).toEqual([{ sessionId: childId }]);
    // The subagent's session closes before the one hosting it.
    expect(
      events.findIndex((event) => event.type === "session.closed" && event.sessionId === grandchildId),
    ).toBeLessThan(
      events.findIndex((event) => event.type === "session.closed" && event.sessionId === childId),
    );
    expect(
      itemsFor(events, childId)
        .filter((item) => item.id === spawnRowId)
        .at(-1),
    ).toMatchObject({ status: "completed", detail: { childSessionId: grandchildId } });
    expect(itemsFor(events, grandchildId).map((item) => item.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
  });

  it("keeps following a child that carries on after its subagent reports, into the next one it starts", async () => {
    // A /boost coordinator: it says it is waiting, is handed its worker's report, starts a reviewer,
    // waits again, and only then finishes. The reviewer must open under it like the first worker.
    const REVIEWER = "cccccccc-0000-4000-8000-000000000000";
    process.env.FAKE_SUBAGENT_NESTED = "1";
    process.env.FAKE_SUBAGENT_NESTED_RESUME = "1";
    const { events } = await startedTurn();
    const childId = childIdOf(events);
    const reviewerId = `session-1:subagent:${REVIEWER}`;

    const opened = await waitFor(
      () => childSessions(events).find((event) => event.sessionId === reviewerId),
      "the reviewer's session to open",
    );
    expect(opened).toMatchObject({
      parentSessionId: childId,
      toolCallId: `agy-sub:${CHILD_A}:9:spawn:0:0`,
      title: "Reviewer",
    });
    await waitFor(
      () => (closedSessions(events, childId).length > 0 ? true : undefined),
      "the child's session to close",
    );

    // Completed once, after it said its real last word, and closed after the reviewer.
    expect(
      events.filter(
        (event) => event.type === "session.turn" && event.sessionId === childId && event.state === "completed",
      ),
    ).toHaveLength(1);
    expect(itemsFor(events, childId).at(-1)).toMatchObject({
      type: "assistant_message",
      text: "Both workers reported; the task is done.",
    });
    expect(
      events.findIndex((event) => event.type === "session.closed" && event.sessionId === reviewerId),
    ).toBeLessThan(
      events.findIndex((event) => event.type === "session.closed" && event.sessionId === childId),
    );
    expect(closedSessions(events, childId)).toEqual([{ sessionId: childId }]);
  });

  it("cancels a running subagent and stops following its transcript on interrupt", async () => {
    // The gate holds the parent's answer, so the child is still running when the interrupt lands.
    process.env.FAKE_SUBAGENT_GATE = join(tempDir, "subagent-gate");
    const { connection, events } = await startedTurn();
    const childId = childIdOf(events);
    await waitFor(
      () => (itemsFor(events, childId).length === 3 ? true : undefined),
      "the child's calls to arrive",
    );
    expect(
      itemsFor(events, childId).flatMap((item) =>
        item.type === "tool_call" ? [item.status] : [],
      ),
    ).toEqual(["completed", "completed"]);

    // The child's transcript grows without saying anything new here — a step written twice, a line
    // caught mid-write — and a row whose render has not moved must not go through Paseo again.
    const published = subagentRows(events).length;
    appendFileSync(childTranscriptFile(events), repeatedChildLine(), "utf8");
    await waitOutAPoll();
    expect(subagentRows(events)).toHaveLength(published);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the parent's turn to be canceled");
    expect(subagentRows(events).at(-1)).toMatchObject({ status: "canceled", error: null });
    await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.turn" && event.sessionId === childId && event.state === "canceled",
        ),
      "the child's turn to be canceled",
    );
    // A child that ended canceled closes with the same error: a silent close would read as a child
    // that completed.
    expect(closedSessions(events, childId)).toEqual([
      { sessionId: childId, error: { message: "Interrupted" } },
    ]);

    // The child's transcript is finished by hand exactly where its last word would have gone — and
    // that line is its last word, so the transcript now reads as a finished child. A tailer that
    // stopped with the canceled turn must publish none of it: no row, and no completed turn for a
    // child that was already settled canceled.
    const settled = events.length;
    const file = childTranscriptFile(events);
    appendFileSync(file, finalChildLine(5), "utf8");
    expect(
      renderChild(parseTranscriptLines(readFileSync(file, "utf8")).entries, {
        childConversationId: CHILD_A,
        parentConversationId: CONVERSATION_ID,
        cwd: tempDir,
      }).done,
    ).toBe(true);
    await waitOutAPoll();
    expect(childEvents(events.slice(settled), childId)).toEqual([]);
    expect(subagentRows(events).at(-1)).toMatchObject({ status: "canceled" });
  });

  it("closes every child's session before the parent's and publishes nothing afterwards", async () => {
    process.env.FAKE_SUBAGENT_GATE = join(tempDir, "subagent-gate");
    const { connection, events } = await startedTurn();
    const childId = childIdOf(events);
    await waitFor(
      () => (itemsFor(events, childId).length === 3 ? true : undefined),
      "the child's calls to arrive",
    );

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed" && event.sessionId === "session-1"),
      "the session to close",
    );
    // The child was still running, so the parent closes it — first, and with an error: a silent
    // close would tell the host it had completed.
    expect(closedSessions(events)).toEqual([
      { sessionId: childId, error: { message: "The session was closed before the subagent finished" } },
      { sessionId: "session-1" },
    ]);

    const settled = events.length;
    appendFileSync(childTranscriptFile(events), finalChildLine(5), "utf8");
    await waitOutAPoll();
    expect(childEvents(events.slice(settled), childId)).toEqual([]);
  });

  it("closes a replayed child whose transcript is gone with an error", async () => {
    // The gate holds the child open, so the turn ends with the child still running — and with the
    // rows it had already produced stored under its own conversation.
    process.env.FAKE_SUBAGENT_GATE = join(tempDir, "subagent-gate");
    const { connection, events } = await startedTurn();
    const childId = childIdOf(events);
    await waitFor(
      () => (itemsFor(events, childId).length === 3 ? true : undefined),
      "the child's calls to arrive",
    );
    const transcript = childTranscriptFile(events);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.turn" && event.sessionId === childId && event.state === "canceled",
        ),
      "the child's turn to be canceled",
    );
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed" && event.sessionId === "session-1"),
      "the session to close",
    );

    // Antigravity prunes its brain directory, so the next session finds the rows and no transcript.
    rmSync(transcript, { force: true });

    const replayConnection = await createProvider().connect({ versions: [1], capabilities: OFFERED });
    openConnections.push(replayConnection);
    const replayed = watchConnection(replayConnection);
    await replayConnection.send({
      type: "session.open",
      requestId: "open-replay",
      sessionId: "session-replay",
      config: sessionConfig(),
      history: "replay",
      persistence: { version: 1, data: { conversationId: CONVERSATION_ID } },
    } as ProviderInput);

    // Its stored rows are replayed, and then the child ends where they do rather than staying open
    // forever: there is nothing left to follow it through.
    const replayChildId = `session-replay:subagent:${CHILD_A}`;
    expect(itemsFor(replayed, replayChildId).map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
    ]);
    expect(closedSessions(replayed, replayChildId)).toEqual([
      {
        sessionId: replayChildId,
        error: { message: "The subagent's transcript is no longer available" },
      },
    ]);
  });

  it("replays a child's session and rows together with the parent's", async () => {
    const { connection, events } = await startedTurn();
    const childId = childIdOf(events);
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "session.turn" && event.sessionId === childId && event.state === "completed",
        )
          ? true
          : undefined,
      "the child to finish",
    );
    await waitFor(() => turns(events, "completed")[0], "the parent's turn to complete");
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed" && event.sessionId === "session-1"),
      "the session to close",
    );
    // The child had settled when it finished, so the parent's own close does not close it again.
    expect(closedSessions(events)).toEqual([{ sessionId: childId }, { sessionId: "session-1" }]);

    const replayConnection = await createProvider().connect({ versions: [1], capabilities: OFFERED });
    openConnections.push(replayConnection);
    const replayed = watchConnection(replayConnection);
    await replayConnection.send({
      type: "session.open",
      requestId: "open-replay",
      sessionId: "session-replay",
      config: sessionConfig(),
      history: "replay",
      persistence: { version: 1, data: { conversationId: CONVERSATION_ID } },
    } as ProviderInput);

    // The row now links to the id this parent session gives the child, and the child comes with
    // the stored rows it produced, all of it before the parent says it is ready.
    const replayChildId = `session-replay:subagent:${CHILD_A}`;
    const row = subagentRows(replayed).at(-1);
    expect(row?.detail).toMatchObject({
      type: "sub_agent",
      subAgentType: "research",
      childSessionId: replayChildId,
    });
    expect(reported(row!)).toMatchObject({ conversationId: CHILD_A, done: true });
    expect(itemsFor(replayed, replayChildId).map((item) => item.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);

    const rowIndex = replayed.findIndex(
      (event) => event.type === "timeline.item" && event.item.id === row?.id,
    );
    const childOpen = replayed.findIndex(
      (event) => event.type === "session.opened" && event.sessionId === replayChildId,
    );
    const childReady = replayed.findIndex(
      (event) => event.type === "session.ready" && event.sessionId === replayChildId,
    );
    const parentReady = replayed.findIndex(
      (event) => event.type === "session.ready" && event.sessionId === "session-replay",
    );
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(childOpen).toBeGreaterThan(rowIndex);
    expect(childReady).toBeGreaterThan(childOpen);
    expect(parentReady).toBeGreaterThan(childReady);

    // The child had already finished when it was stored, so its replayed session ends with its
    // replayed turn — closed, and closed before the parent says it is ready: a child the host is
    // still counting as live is one it reports as failed on the next connection loss.
    expect(closedSessions(replayed, replayChildId)).toEqual([{ sessionId: replayChildId }]);
    const childClosed = replayed.findIndex(
      (event) => event.type === "session.closed" && event.sessionId === replayChildId,
    );
    expect(childClosed).toBeGreaterThan(turnIndex(replayed, replayChildId, "completed"));
    expect(childClosed).toBeLessThan(parentReady);

    await replayConnection.send({
      type: "session.close",
      requestId: "close-replay",
      sessionId: "session-replay",
    });
    await waitFor(
      () =>
        replayed.find(
          (event) => event.type === "session.closed" && event.sessionId === "session-replay",
        ),
      "the replayed session to close",
    );
    expect(closedSessions(replayed)).toEqual([
      { sessionId: replayChildId },
      { sessionId: "session-replay" },
    ]);
  });

  it("replays a subagent's own subagent under the subagent that started it", async () => {
    const GRANDCHILD = "bbbbbbbb-0000-4000-8000-000000000000";
    process.env.FAKE_SUBAGENT_NESTED = "1";
    const { connection, events } = await startedTurn();
    const grandchildId = `session-1:subagent:${GRANDCHILD}`;
    await waitFor(
      () => (turnIndex(events, grandchildId, "completed") >= 0 ? true : undefined),
      "the nested subagent to finish",
    );
    await waitFor(() => turns(events, "completed")[0], "the parent's turn to complete");
    await waitFor(
      () => (closedSessions(events, childIdOf(events)).length > 0 ? true : undefined),
      "the child's session to close",
    );
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed" && event.sessionId === "session-1"),
      "the session to close",
    );

    const replayConnection = await createProvider().connect({ versions: [1], capabilities: OFFERED });
    openConnections.push(replayConnection);
    const replayed = watchConnection(replayConnection);
    await replayConnection.send({
      type: "session.open",
      requestId: "open-replay",
      sessionId: "session-replay",
      config: sessionConfig(),
      history: "replay",
      persistence: { version: 1, data: { conversationId: CONVERSATION_ID } },
    } as ProviderInput);

    const replayChildId = `session-replay:subagent:${CHILD_A}`;
    const replayGrandchildId = `session-replay:subagent:${GRANDCHILD}`;
    const spawnRowId = `agy-sub:${CHILD_A}:5:spawn:0:0`;
    // The row sits in the child's replayed timeline and links to the subagent's session, which
    // hangs off the child and not off the conversation.
    expect(
      itemsFor(replayed, replayChildId)
        .filter((item) => item.id === spawnRowId)
        .at(-1),
    ).toMatchObject({
      name: "invoke_subagent",
      status: "completed",
      detail: { type: "sub_agent", childSessionId: replayGrandchildId },
    });
    expect(
      replayed.find((event) => event.type === "session.opened" && event.sessionId === replayGrandchildId),
    ).toMatchObject({ parentSessionId: replayChildId, toolCallId: spawnRowId });
    expect(itemsFor(replayed, replayGrandchildId).map((item) => item.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    // Both ended with their stored turns, before the conversation said it was ready.
    expect(closedSessions(replayed, replayGrandchildId)).toEqual([{ sessionId: replayGrandchildId }]);
    expect(closedSessions(replayed, replayChildId)).toEqual([{ sessionId: replayChildId }]);
  });
});


describe("background commands", () => {
  function heldTurn(): void {
    process.env.FAKE_SCENARIO = "background";
    process.env.PASEO_ANTIGRAVITY_BACKFILL_DELAY_MS = "50";
    process.env.FAKE_BACKGROUND_GATE = join(tempDir, "background-gate");
    const home = join(tempDir, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
  }

  it("completes a turn from the transcript while a background command holds the stream", async () => {
    heldTurn();
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "start it");
    await waitFor(() => turns(events, "completed")[0], "the held turn to complete");

    expect([...paseoView(events).messages.values()]).toEqual([
      "Starting the server.",
      "The server is running (start it).",
    ]);
    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    const last = new Map(calls.map((item) => [item.id, item]));
    expect([...last.values()].map((item) => [item.detail.type === "shell" && item.detail.command, item.status])).toEqual([
      ["npm start", "completed"],
      ["curl -s localhost:4719/health", "completed"],
    ]);
    expect(
      events.filter((event) => event.type === "session.notice" && event.notice.id === "agy-background-task"),
    ).toHaveLength(1);

    // The task ends and the held CLI prints everything it owed: none of it may be shown twice.
    const settled = paseoView(events).messages;
    const count = events.length;
    writeFileSync(process.env.FAKE_BACKGROUND_GATE ?? "", "");
    // A real delay: what is asserted is that the detached CLI's late output produces *no* event,
    // and there is no signal to await for something that must not happen.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events.slice(count).filter((event) => event.type !== "session.notice")).toEqual([]);
    expect(paseoView(events).messages).toEqual(settled);
  });

  it("resumes the conversation in a fresh CLI for the next prompt", async () => {
    heldTurn();
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "start it");
    await waitFor(() => turns(events, "completed")[0], "the held turn to complete");

    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "next", "m2");
    await waitFor(() => turns(events, "completed")[1], "the next turn to complete");

    expect(paseoView(events).finalText).toBe("echo:next\n");
    const launches = readArgvLog();
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain("--conversation");
  });

  it("stops the detached CLI as soon as its model carries on without the user", async () => {
    heldTurn();
    const pidFile = join(tempDir, "resumed.pid");
    process.env.FAKE_BACKGROUND_RESUME = pidFile;
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "scaffold it");
    await waitFor(() => turns(events, "completed")[0], "the held turn to complete");

    // The background task ends, and the transcript shows the model working past its answer.
    writeFileSync(process.env.FAKE_BACKGROUND_GATE ?? "", "");
    const pid = Number(await waitFor(() => (existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined), "the model to resume"));
    await waitFor(
      () => events.find((event) => event.type === "session.notice" && event.notice.id === "agy-background-resumed"),
      "the resumed CLI to be stopped",
    );
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(() => (alive() ? undefined : true), "the resumed CLI to exit");
    expect(turns(events, "started")).toHaveLength(1);

    // The next message resumes the conversation in a fresh CLI.
    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "continue", "m2");
    await waitFor(() => turns(events, "completed")[1], "the next turn to complete");
    expect(readArgvLog()).toHaveLength(2);
    expect(readArgvLog()[1]).toContain("--conversation");
  });

  it("keeps the turn running while the model waits for its background command", async () => {
    heldTurn();
    process.env.FAKE_SCENARIO = "background-wait";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "run them");
    await waitFor(
      () => [...paseoView(events).messages.values()].find((text) => text === "The tests are still running."),
      "the waiting answer after the model looked in on its task",
    );
    // Settling would happen in the same transcript read that published the waiting answer.
    expect(turns(events, "completed")).toEqual([]);

    writeFileSync(process.env.FAKE_BACKGROUND_GATE ?? "", "");
    await waitFor(() => turns(events, "completed")[0], "agy to finish the turn");

    expect([...paseoView(events).messages.values()]).toEqual([
      "Running the tests.",
      "Waiting for the tests to finish.",
      "The tests are still running.",
      "All 12 tests passed (run them).",
    ]);
    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect([...new Map(calls.map((item) => [item.id, [item.name, item.status]])).values()]).toEqual([
      ["run_command", "completed"],
      ["manage_task", "completed"],
      ["view_file", "completed"],
    ]);
    expect(
      events.filter((event) => event.type === "session.notice" && event.notice.id.startsWith("agy-background")),
    ).toEqual([]);
    expect(readArgvLog()).toHaveLength(1);
  });
});

describe("plan mode", () => {
  function permissions(events: ProviderEvent[]) {
    return events.flatMap((event) => (event.type === "session.permission" ? [event.request] : []));
  }
  function resolved(events: ProviderEvent[]): string[] {
    return events.flatMap((event) => (event.type === "session.permission_resolved" ? [event.permissionId] : []));
  }

  it("tells the model to plan and offers its answer as a plan to implement", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "plan" });
    await prompt(connection, "add a cache");
    await waitFor(() => permissions(events)[0], "the plan prompt");

    expect(readPrompts()[0]).toMatch(/^<plan_mode>[\s\S]*Do not implement the plan[\s\S]*<\/plan_mode>\n\nadd a cache$/);
    expect(permissions(events)[0]).toMatchObject({
      kind: "plan",
      detail: expect.objectContaining({ type: "plan" }),
      actions: [
        expect.objectContaining({ id: "implement", behavior: "allow", intent: "implement" }),
        expect.objectContaining({ id: "dismiss", behavior: "deny", intent: "dismiss" }),
      ],
    });
    const request = permissions(events)[0];
    expect(request?.detail?.type === "plan" && request.detail.text).toContain("echo:");
  });

  it("never launches the CLI in a mode agy cannot honour", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "plan" });
    await prompt(connection, "add a cache");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // Probed 2026-09-25 on agy 1.2.11: `--mode plan` has no effect while slash-command expansion
    // is disabled (`warning: --mode plan has no effect while slash command expansion is disabled`),
    // and with expansion on — which is what it would take — the CLI approves its own plan review
    // and implements in the same turn (fixtures/16-plan-mode.ndjson). So the flag is not passed at
    // all: Paseo's plan mode is the preamble, which planned and stopped under both policies.
    const argv = readArgv();
    expect(argv).not.toContain("--mode");
    expect(argv).toContain("--disable-slash-commands");
    expect(readPrompts()[0]).toMatch(/^<plan_mode>/);
  });

  it("keeps a plain /-leading plan-mode message out of the CLI's slash parser", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "plan" });
    await prompt(connection, "/skills");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // Probed 2026-09-25 on agy 1.2.11: `/skills` as the first token of a turn on an expansion-on
    // CLI fails the turn outright (`error: /skills is answered by the CLI itself and is unavailable
    // with --input-format stream-json`), and a leading space does not help — the CLI trims it. The
    // plan-mode process keeps expansion disabled, and the preamble is in front of the message as
    // well, so the text goes to the model unaltered: no escape character is added to it.
    expect(readArgv()).toContain("--disable-slash-commands");
    const [outgoing] = readPrompts();
    expect(outgoing?.startsWith("<plan_mode>")).toBe(true);
    expect(outgoing?.endsWith("\n\n/skills")).toBe(true);
  });

  it("implements an approved plan in accept-edits mode", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "plan" });
    await prompt(connection, "add a cache");
    const request = await waitFor(() => permissions(events)[0], "the plan prompt");

    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: request.id,
      response: { behavior: "allow", selectedActionId: "implement" },
    });
    await waitFor(() => turns(events, "completed")[1], "the implementing turn to complete");

    expect(resolved(events)).toEqual([request.id]);
    const configs = events.flatMap((event) => (event.type === "session.config" ? [event.config.mode] : []));
    expect(configs.at(-1)).toBe("accept-edits");
    expect(readPrompts()[1]).toBe("The plan is approved. Implement it now.");
    const launches = readArgvLog();
    expect(launches.at(-1)).toEqual(expect.arrayContaining(["--mode", "accept-edits", "--conversation"]));
    // Implementing is a plain accept-edits turn, and every non-command turn keeps expansion off.
    expect(launches.at(-1)).toContain("--disable-slash-commands");
    // The implementing turn is no plan, so it asks for nothing.
    expect(permissions(events)).toHaveLength(1);
  });

  it("keeps planning when the plan is dismissed or a new message is sent instead", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "plan" });
    await prompt(connection, "add a cache");
    const first = await waitFor(() => permissions(events)[0], "the first plan prompt");
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: first.id,
      response: { behavior: "deny", selectedActionId: "dismiss" },
    });
    expect(resolved(events)).toEqual([first.id]);
    expect(turns(events, "started")).toHaveLength(1);

    await prompt(connection, "use redis instead", "m2");
    const second = await waitFor(() => permissions(events)[1], "the second plan prompt");
    await prompt(connection, "actually, in memory", "m3");
    await waitFor(() => turns(events, "completed")[2], "the third turn to complete");
    expect(resolved(events)).toEqual([first.id, second.id]);
    expect(readPrompts().every((text) => text.startsWith("<plan_mode>"))).toBe(true);
  });

  it("asks nothing outside plan mode", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "accept-edits" });
    await prompt(connection, "add a cache");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    expect(permissions(events)).toEqual([]);
    expect(readPrompts()[0]).toBe("add a cache");
  });

  it("runs /plan as the plugin's plan turn, never the CLI's self-approving workflow", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "c1",
        delivery: "auto",
        input: { type: "command", name: "plan", arguments: "add a cache" },
      },
    } as ProviderInput);
    const request = await waitFor(() => permissions(events)[0], "the plan prompt");

    // Observed 2026-09-29: agy's own `/plan` approved its own plan review and implemented it.
    // So the command is never expanded by the CLI: the preamble carries it, expansion stays off.
    expect(readPrompts()[0]).toMatch(/^<plan_mode>[\s\S]*<\/plan_mode>\n\nadd a cache$/);
    expect(readArgv()).toContain("--disable-slash-commands");
    expect(request.kind).toBe("plan");
    const shown = timelineItems(events).find((item) => item.type === "user_message");
    expect(shown?.type === "user_message" && shown.text).toBe("/plan add a cache");

    // The session was never in plan mode, so implementing keeps the mode it had.
    const configsBefore = events.filter((event) => event.type === "session.config").length;
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: request.id,
      response: { behavior: "allow", selectedActionId: "implement" },
    });
    await waitFor(() => turns(events, "completed")[1], "the implementing turn to complete");
    expect(events.filter((event) => event.type === "session.config")).toHaveLength(configsBefore);
    expect(readPrompts()[1]).toBe("The plan is approved. Implement it now.");
    expect(readArgvLog().at(-1)).not.toContain("--mode");
    expect(permissions(events)).toHaveLength(1);
  });
});

describe("questions agy skips", () => {
  function permissions(events: ProviderEvent[]) {
    return events.flatMap((event) => (event.type === "session.permission" ? [event.request] : []));
  }
  function resolved(events: ProviderEvent[]): string[] {
    return events.flatMap((event) => (event.type === "session.permission_resolved" ? [event.permissionId] : []));
  }
  function questionRows(events: ProviderEvent[]) {
    return timelineItems(events).filter((item) => item.type === "tool_call" && item.name === "ask_question");
  }
  function lastRowText(events: ProviderEvent[]): string {
    const row = questionRows(events).at(-1);
    return row?.type === "tool_call" && row.detail.type === "plain_text" ? (row.detail.text ?? "") : "";
  }
  /**
   * The fake plays fixtures/17: the question, agy's own "User Skipped" answer in the transcript,
   * and then a gate. Held there, it carries on and acts on the skip only if nobody stops it first.
   */
  function askingAgy(options: { hold?: boolean } = {}): void {
    process.env.FAKE_SCENARIO = "ask-question";
    if (options.hold !== false) process.env.FAKE_QUESTION_GATE = join(tempDir, "question-gate");
    const home = join(tempDir, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
  }
  async function answer(
    connection: ProviderConnection,
    permissionId: string,
    response: Extract<ProviderInput, { type: "session.permission" }>["response"],
  ): Promise<void> {
    await connection.send({ type: "session.permission", sessionId: "session-1", permissionId, response });
  }

  it("stops the turn at the skipped question and offers it as a question card", async () => {
    askingAgy();
    const effect = join(tempDir, "color.txt");
    process.env.FAKE_QUESTION_EFFECT = effect;
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "pick a colour");
    const request = await waitFor(() => permissions(events)[0], "the question card");

    expect(request).toMatchObject({
      kind: "question",
      name: "ask_question",
      title: "Which colour do you prefer?",
      input: {
        questions: [
          {
            question: "Which colour do you prefer?",
            header: "Question 1",
            options: [{ label: "Red" }, { label: "Blue" }],
            multiSelect: false,
            allowOther: true,
          },
        ],
      },
    });
    // The stop is the plugin's, so the turn completed rather than being cancelled by the user.
    expect(turns(events, "completed")).toHaveLength(1);
    expect(turns(events, "canceled")).toEqual([]);
    expect(lastRowText(events)).toBe("Which colour do you prefer?\nRed, Blue");

    // The CLI was stopped, not just ignored: opening its gate now must not let it act on the skip.
    const count = events.length;
    writeFileSync(process.env.FAKE_QUESTION_GATE ?? "", "");
    // A real delay: what is asserted is that the stopped CLI does *nothing*, and there is no signal
    // to await for something that must not happen.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(effect)).toBe(false);
    expect(events.slice(count)).toEqual([]);
  });

  it("sends the answer as the next turn of the same conversation", async () => {
    askingAgy();
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "pick a colour");
    const request = await waitFor(() => permissions(events)[0], "the question card");

    await answer(connection, request.id, {
      behavior: "allow",
      updatedInput: { ...request.input, answers: { "Question 1": "Blue" } },
    });
    await waitFor(() => turns(events, "completed")[1], "the answer turn to complete");

    expect(resolved(events)).toEqual([request.id]);
    const sent = readPrompts()[1] ?? "";
    // The conversation holds "User Skipped" as the call's result; the model is told it was the CLI.
    expect(sent).toContain('returned "User Skipped"');
    expect(sent).toContain("Which colour do you prefer?\nBlue");
    const launches = readArgvLog();
    expect(launches).toHaveLength(2);
    expect(launches[1]).toEqual(expect.arrayContaining(["--conversation", "--disable-slash-commands"]));
    expect(lastRowText(events)).toBe("Which colour do you prefer?\nBlue");
    const shown = timelineItems(events).filter((item) => item.type === "user_message").at(-1);
    expect(shown).toMatchObject({ text: "Answers to your questions:\n\nWhich colour do you prefer?\nBlue" });
  });

  it("offers every question of one call and returns each answer under its own question", async () => {
    askingAgy();
    process.env.FAKE_QUESTIONS = JSON.stringify([
      { is_multi_select: true, options: ["Apple", "Pear", "Plum"], question: "Which fruits do you like?" },
      { is_multi_select: false, options: ["Ace", "Bee"], question: "Which nickname should I use for you?" },
    ]);
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "ask me");
    const request = await waitFor(() => permissions(events)[0], "the question card");
    expect(request.input?.questions).toMatchObject([
      { header: "Question 1", multiSelect: true },
      { header: "Question 2", multiSelect: false },
    ]);

    // What Paseo's card submits: labels of a multi-select joined with ", ", a write-in as its text.
    await answer(connection, request.id, {
      behavior: "allow",
      updatedInput: { answers: { "Question 1": "Apple, Plum", "Question 2": "Zed" } },
    });
    await waitFor(() => turns(events, "completed")[1], "the answer turn to complete");
    expect(readPrompts()[1]).toContain(
      "Which fruits do you like?\nApple, Plum\n\nWhich nickname should I use for you?\nZed",
    );
  });

  it("leaves an unknown step that is not a skipped question alone", async () => {
    askingAgy({ hold: false });
    process.env.FAKE_QUESTION_TOOL = "list_tasks";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "list tasks");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(paseoView(events).finalText).toBe("There are no tasks.");
    expect(permissions(events)).toEqual([]);
    expect(questionRows(events)).toEqual([]);
  });

  it("sends nothing when the question is dismissed", async () => {
    askingAgy();
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "pick a colour");
    const request = await waitFor(() => permissions(events)[0], "the question card");

    await answer(connection, request.id, { behavior: "deny" });

    expect(resolved(events)).toEqual([request.id]);
    expect(lastRowText(events)).toBe("Which colour do you prefer?\nRed, Blue\n\nDismissed");
    expect(turns(events, "started")).toHaveLength(1);
    expect(readArgvLog()).toHaveLength(1);
  });

  it("withdraws the question when a new message is sent instead", async () => {
    askingAgy();
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "pick a colour");
    const request = await waitFor(() => permissions(events)[0], "the question card");

    await prompt(connection, "use Red", "m2");
    await waitFor(() => turns(events, "completed")[1], "the new message to complete");

    const withdrawn = events.findIndex(
      (event) => event.type === "session.permission_resolved" && event.permissionId === request.id,
    );
    const started = events.findIndex(
      (event) => event.type === "session.turn" && event.state === "started" && event.turnId === turnIds(events, "started")[1],
    );
    expect(withdrawn).toBeGreaterThan(-1);
    expect(withdrawn).toBeLessThan(started);
    expect(readPrompts()[1]).toBe("use Red");
    expect(lastRowText(events)).toContain("Dismissed");
  });

  it("runs a message queued behind the asking turn instead of asking", async () => {
    askingAgy();
    const { connection, events } = await connect();
    await openSession(connection);
    // Both lines reach the CLI before it reports the question, so the second is queued inside it.
    await prompt(connection, "pick a colour");
    await prompt(connection, "never mind, use Red", "m2");
    await waitFor(() => turns(events, "completed")[1], "the queued message to complete");

    expect(permissions(events)).toEqual([]);
    expect(paseoView(events).finalText).toBe("echo:never mind, use Red\n");
    const launches = readArgvLog();
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain("--conversation");
    expect(lastRowText(events)).toContain("Dismissed");
  });

  it("withdraws an open question when the session closes", async () => {
    askingAgy();
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "pick a colour");
    const request = await waitFor(() => permissions(events)[0], "the question card");

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    const withdrawn = events.findIndex(
      (event) => event.type === "session.permission_resolved" && event.permissionId === request.id,
    );
    const closed = events.findIndex((event) => event.type === "session.closed" && event.sessionId === "session-1");
    expect(withdrawn).toBeGreaterThan(-1);
    expect(withdrawn).toBeLessThan(closed);
  });

  it("answers a question from a command turn on a plain launch", async () => {
    askingAgy();
    const { connection, events } = await connect();
    await openSession(connection);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "c1",
        delivery: "auto",
        input: { type: "command", name: "teamwork-preview", arguments: "add a hello script" },
      },
    } as ProviderInput);
    const request = await waitFor(() => permissions(events)[0], "the question card");
    await answer(connection, request.id, { behavior: "allow", updatedInput: { answers: { "Question 1": "Red" } } });
    await waitFor(() => turns(events, "completed")[1], "the answer turn to complete");

    const launches = readArgvLog();
    // `/teamwork-preview` needs expansion; its answer is a message and must not be expanded.
    expect(launches[0]).not.toContain("--disable-slash-commands");
    expect(launches[1]).toEqual(expect.arrayContaining(["--conversation", "--disable-slash-commands"]));
  });

  it("asks before the plan, and offers the plan once the answer is in", async () => {
    askingAgy();
    const { connection, events } = await connect();
    await openSession(connection, { mode: "plan" });
    await prompt(connection, "plan a greeting");
    const request = await waitFor(() => permissions(events)[0], "the question card");
    expect(request.kind).toBe("question");

    await answer(connection, request.id, { behavior: "allow", updatedInput: { answers: { "Question 1": "Blue" } } });
    const plan = await waitFor(() => permissions(events)[1], "the plan card");

    // The stopped turn's text is no plan; the answer turn is still a plan-mode turn.
    expect(permissions(events).map((entry) => entry.kind)).toEqual(["question", "plan"]);
    expect(plan.kind).toBe("plan");
    expect(readPrompts()[1]).toMatch(/^<plan_mode>[\s\S]*Which colour do you prefer\?\nBlue/);
  });

  it("lets agy settle the question on a structured-output turn", async () => {
    askingAgy({ hold: false });
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "pick a colour" }], "m1", {
      type: "object",
      properties: { colour: { type: "string" } },
    });
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(permissions(events)).toEqual([]);
    expect(paseoView(events).finalText).toContain("so I picked Red");
    expect(readArgvLog()).toHaveLength(1);
  });

  it("lets agy settle the question when the host cannot show a card", async () => {
    askingAgy({ hold: false });
    const connection = await createProvider().connect({
      versions: [1],
      capabilities: OFFERED.filter((capability) => capability !== "permission"),
    });
    openConnections.push(connection);
    const events = watchConnection(connection);
    await openSession(connection);
    await prompt(connection, "pick a colour");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(permissions(events)).toEqual([]);
    expect(paseoView(events).finalText).toContain("so I picked Red");
  });
});

describe("resolveChildCwd", () => {
  const PARENT = "/Users/dev/parent-workspace";

  it("takes the directory a file:// workspace URI names", () => {
    expect(resolveChildCwd(PARENT, ["file:///Users/dev/worktrees/abc/child"])).toBe(
      "/Users/dev/worktrees/abc/child",
    );
    // The URI is decoded rather than used as written, like every other file URL this plugin reads.
    expect(resolveChildCwd(PARENT, ["file:///Users/dev/a%20b"])).toBe("/Users/dev/a b");
  });

  it("leaves the child in the parent's directory for anything else", () => {
    // agy reports `file://` URIs; another scheme is not a directory this plugin may hand a child.
    expect(resolveChildCwd(PARENT, ["https://example.com/workspace"])).toBe(PARENT);
    // Neither is a bare path, which the capture of an `inherit` child would never carry.
    expect(resolveChildCwd(PARENT, ["/Users/dev/agy-subagent-probe2"])).toBe(PARENT);
    // A `file://` URI whose path cannot be decoded is no better than a missing one.
    expect(resolveChildCwd(PARENT, ["file://%ZZ/workspace"])).toBe(PARENT);
  });

  it("leaves the child in the parent's directory when there is no URI at all", () => {
    expect(resolveChildCwd(PARENT, [])).toBe(PARENT);
    expect(resolveChildCwd(PARENT, ["   "])).toBe(PARENT);
    expect(resolveChildCwd(PARENT, undefined)).toBe(PARENT);
  });
});

describe("accounts", () => {
  /**
   * The real home a test works against. Every account's shadow home mirrors it, so a test that
   * repointed `HOME` to it proves both directions: what the child sees, and what the plugin reads.
   */
  function realHome(): string {
    const home = join(tempDir, "home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    process.env.HOME = home;
    return home;
  }

  /** Where `server/accounts.ts` puts an account's shadow home, under this test's `PASEO_HOME`. */
  function shadowHome(id: string): string {
    return join(
      process.env.PASEO_HOME ?? "",
      "plugin-data",
      "antigravity-cli",
      "accounts",
      id,
      "home",
    );
  }

  /** What the last `agy` launch received, as `testing/fake-agy.mjs` recorded it. */
  function launchEnv(): { HOME?: string | null } {
    return existsSync(envFile)
      ? (JSON.parse(readFileSync(envFile, "utf8")) as { HOME?: string | null })
      : {};
  }

  async function persistedAccount(
    events: ProviderEvent[],
  ): Promise<Extract<ProviderEvent, { type: "session.persistence" }>["persistence"]> {
    return (
      await waitFor(
        () =>
          events.find(
            (event): event is Extract<ProviderEvent, { type: "session.persistence" }> =>
              event.type === "session.persistence",
          ),
        "the persistence event",
      )
    ).persistence;
  }

  function settingsOf(events: ProviderEvent[]): readonly ProviderSetting[] {
    const config = events.filter((event) => event.type === "session.config").at(-1);
    return config?.type === "session.config" ? config.config.settings : [];
  }

  it("runs a new session under the active account's shadow home", async () => {
    const home = realHome();
    writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}", "utf8");
    addAccount("Work");
    setActive("work");
    // Created after the account was: it must be linked on the way to the launch, not only at add.
    writeFileSync(join(home, ".real-entry-created-later"), "later\n", "utf8");

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // End to end: the child itself resolved the account's home, and the shadow home it was given
    // reads the real home's settings through the link.
    expect(launchEnv().HOME).toBe(shadowHome("work"));
    expect(statSync(join(shadowHome("work"), ".gemini")).isDirectory()).toBe(true);
    expect(existsSync(join(shadowHome("work"), ".gemini", "antigravity-cli", "settings.json"))).toBe(
      true,
    );
    expect(existsSync(join(shadowHome("work"), ".real-entry-created-later"))).toBe(true);
    // The plugin's own process keeps the real home: only the child is ever repointed.
    expect(process.env.HOME).toBe(home);
  });

  it("adds no HOME to a Default launch that had none configured", async () => {
    realHome();
    // Neither the config nor the environment names a home, which is Default's whole behaviour.
    delete process.env.HOME;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(launchEnv()).toEqual({ HOME: null });
  });

  it("gives the account's home precedence over a HOME the session configures", async () => {
    realHome();
    addAccount("Work");
    setActive("work");

    const { connection, events } = await connect();
    await openSession(connection, { env: { HOME: "/decoy" } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(launchEnv().HOME).toBe(shadowHome("work"));
  });

  it("keeps today's precedence for Default: the session's own env wins", async () => {
    realHome();

    const { connection, events } = await connect();
    await openSession(connection, { env: { HOME: "/decoy" } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(launchEnv().HOME).toBe("/decoy");
  });

  it("emits the account beside the conversation id, and resumes under it from then on", async () => {
    realHome();
    addAccount("Work");
    setActive("work");

    const first = await connect();
    await openSession(first.connection);
    await prompt(first.connection, "hello");
    await waitFor(() => turns(first.events, "completed")[0], "the first turn to complete");

    const persistence = await persistedAccount(first.events);
    expect(persistence).toEqual({
      version: 1,
      data: { conversationId: "11111111-2222-3333-4444-555555555555", accountId: "work" },
    });

    // Another account is active now; the resume must still run under the one that created it.
    addAccount("Personal");
    setActive("personal");
    const second = await connect();
    await openSession(second.connection, {}, {
      sessionId: "session-2",
      history: "replay",
      persistence,
    });
    await prompt(second.connection, "again", "m2", "session-2");
    await waitFor(() => turns(second.events, "completed", "session-2")[0], "the resumed turn");

    expect(launchEnv().HOME).toBe(shadowHome("work"));
    expect(readArgv()).toContain("--conversation");
    const opened = second.events.find(
      (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
        event.type === "session.opened",
    );
    expect(opened?.persistence).toEqual(persistence);
  });

  it("keeps a session on its own account when the active one changes under it", async () => {
    realHome();
    addAccount("Work");
    addAccount("Personal");
    setActive("work");

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(launchEnv().HOME).toBe(shadowHome("work"));

    setActive("personal");
    // A command turn replaces the CLI, so this is a fresh launch that must still see `work`.
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "c1",
        delivery: "auto",
        input: { type: "command", name: "goal", arguments: "say ok" },
      },
    } as ProviderInput);
    await waitFor(() => turns(events, "completed")[1], "the command turn to complete");

    expect(readArgvLog()).toHaveLength(2);
    expect(launchEnv().HOME).toBe(shadowHome("work"));
    expect(launchEnv().HOME).not.toBe(shadowHome("personal"));
  });

  it("resumes a conversation written before accounts existed under Default", async () => {
    const home = realHome();
    addAccount("Work");
    setActive("work");

    // A blob with no `accountId`: only Default could have written it, whatever is active now.
    const persistence = {
      version: 1,
      data: { conversationId: "11111111-2222-3333-4444-555555555555" },
    };
    const { connection, events } = await connect();
    await openSession(connection, { env: { HOME: "/decoy" } }, {
      history: "replay",
      persistence,
    });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(launchEnv().HOME).toBe("/decoy");
    expect(process.env.HOME).toBe(home);
    expect(readArgv()).toContain("--conversation");
    const opened = events.find(
      (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
        event.type === "session.opened",
    );
    expect(opened?.persistence).toEqual({
      version: 1,
      data: { conversationId: persistence.data.conversationId, accountId: "default" },
    });
  });

  it("refuses to resume a conversation whose account is gone, naming it", async () => {
    realHome();
    addAccount("Work");
    setActive("work");

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    const persistence = await persistedAccount(events);

    removeAccount("work");

    const second = await connect();
    await expect(
      openSession(second.connection, {}, {
        sessionId: "session-2",
        history: "replay",
        persistence,
      }),
    ).rejects.toThrow(/account "work" no longer exists/);
    // The failed open leaves nothing behind.
    expect(second.events.some((event) => event.type === "session.opened")).toBe(false);

    // The session that is already open cannot quietly continue either: the next launch would have
    // no home to use, and a command turn is one (it replaces the CLI). The turn fails, naming the
    // account, rather than falling back to another one.
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "c1",
        delivery: "auto",
        input: { type: "command", name: "goal", arguments: "say ok" },
      },
    } as ProviderInput);
    const failed = await waitFor(() => turns(events, "failed")[0], "the failed turn");
    expect(failed).toMatchObject({
      error: { message: expect.stringContaining("Unknown account: work") },
    });
  });

  function agentValues(events: ProviderEvent[]): string[] {
    const setting = settingsOf(events).find((candidate) => candidate.id === "agent");
    return setting?.type === "select" ? setting.options.map((option) => option.value) : [];
  }

  it("keeps skills and commands on the real home while an account is active", async () => {
    const home = realHome();
    // The shadow home mirrors `config`, `skills` and `antigravity-cli/skills`, but not
    // `antigravity-cli/builtin`: a command found *only* here proves `homedir()` never moved.
    const skill = join(home, ".gemini", "antigravity-cli", "builtin", "skills", "real-only");
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: real-only\ndescription: Only in the real home\n---\n\nSteps.\n",
      "utf8",
    );
    addAccount("Work");
    setActive("work");

    const { connection, events } = await connect();
    await openSession(connection);

    const published = events.find(
      (event): event is Extract<ProviderEvent, { type: "session.commands" }> =>
        event.type === "session.commands",
    );
    expect(published?.commands).toContainEqual({
      name: "real-only",
      description: "Only in the real home",
    });
    expect(process.env.HOME).toBe(home);
  });

  it("reads the approval label and workspace trust from the session's own account", async () => {
    const home = realHome();
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ toolPermission: "request-review" }),
      "utf8",
    );
    addAccount("Work");
    // Seeded from the real file, then changed by `agy` and the accounts screen: work's own values.
    writeFileSync(
      join(shadowHome("work"), ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ toolPermission: "turbo", trustedWorkspaces: [tempDir, realpathSync(tempDir)] }),
      "utf8",
    );
    const agentDir = join(tempDir, ".agents", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "reviewer.md"),
      "---\nname: my-custom-agent\ndescription: Custom reviewer\n---\nPrompt here",
      "utf8",
    );

    setActive("work");
    const work = await connect();
    await openSession(work.connection);

    // A workspace agent is only offered once its own settings trust the workspace, and the approval
    // label names the value `agy` under this account would actually use.
    expect(
      settingsOf(work.events).find((setting) => setting.id === "approvalPolicy"),
    ).toMatchObject({ description: expect.stringContaining("turbo") });
    expect(agentValues(work.events)).toContain("my-custom-agent");

    // Default reads the real file, whose value the account's copy left alone.
    setActive(DEFAULT_ACCOUNT_ID);
    const plain = await connect();
    await openSession(plain.connection, {}, { sessionId: "session-2" });

    expect(
      settingsOf(plain.events).find((setting) => setting.id === "approvalPolicy"),
    ).toMatchObject({ description: expect.stringContaining("request-review") });
    expect(agentValues(plain.events)).not.toContain("my-custom-agent");
  });

  it("backfills a held turn from the account's own brain directory, not the real home's", async () => {
    realHome();
    addAccount("Work");
    setActive("work");
    process.env.FAKE_SCENARIO = "background";
    process.env.PASEO_ANTIGRAVITY_BACKFILL_DELAY_MS = "50";
    process.env.FAKE_BACKGROUND_GATE = join(tempDir, "background-gate");

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "start it");
    await waitFor(() => turns(events, "completed")[0], "the held turn to complete");

    // The child wrote its transcript under its own HOME. The turn can only complete if the poller
    // looked in the account's brain directory: nothing was ever written under the real home.
    expect([...paseoView(events).messages.values()]).toEqual([
      "Starting the server.",
      "The server is running (start it).",
    ]);
    const conversation = "11111111-2222-3333-4444-555555555555";
    expect(
      existsSync(join(shadowHome("work"), ".gemini", "antigravity-cli", "brain", conversation)),
    ).toBe(true);
    expect(
      existsSync(join(process.env.HOME ?? "", ".gemini", "antigravity-cli", "brain", conversation)),
    ).toBe(false);
  });

  it("lists every account's conversations, and an imported one resumes under its own account", async () => {
    const home = realHome();
    const imported = "61d5201e-47e0-405e-9cd3-2264e8b5d740";
    writeConversationDb(home, [
      {
        conversationId: "11111111-1111-1111-1111-111111111111",
        title: "Default conversation",
        preview: "Written by the main account",
        lastModifiedTime: "2026-09-23 09:00:00+00:00",
        workspacePaths: [tempDir],
      },
    ]);
    addAccount("Work");
    // The account's own index, where its CLI writes it: under the shadow home's real `.gemini`.
    writeConversationDb(shadowHome("work"), [
      {
        conversationId: imported,
        title: "Work conversation",
        preview: "Written by the work account",
        lastModifiedTime: "2026-09-23 15:00:00+00:00",
        workspacePaths: [tempDir],
      },
    ]);
    // Default stays active: the resume must follow the row's own account, not the active one.
    const { connection, events } = await connect();
    await connection.send({ type: "sessions", requestId: "list-1", cwd: tempDir } as ProviderInput);
    const listed = await waitFor(
      () =>
        events.find(
          (event): event is Extract<ProviderEvent, { type: "sessions" }> => event.type === "sessions",
        ),
      "the session list",
    );
    expect(
      listed.sessions.map((session) => {
        const data = session.persistence.data;
        const accountId =
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? data.accountId
            : undefined;
        return [accountId, session.title];
      }),
    ).toEqual([
      ["work", "Work conversation"],
      ["default", "Default conversation"],
    ]);

    const second = await connect();
    await openSession(second.connection, {}, {
      sessionId: "session-2",
      history: "replay",
      persistence: listed.sessions[0]?.persistence,
    });
    await prompt(second.connection, "carry on", "m2", "session-2");
    await waitFor(() => turns(second.events, "completed", "session-2")[0], "the imported turn");

    expect(launchEnv().HOME).toBe(shadowHome("work"));
    expect(readArgv()).toContain("--conversation");
    expect(readArgv()[readArgv().indexOf("--conversation") + 1]).toBe(imported);
  });
});
