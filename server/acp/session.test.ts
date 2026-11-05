import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCapability,
  ProviderEvent,
  ProviderInput,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { FakeAcpAgent } from "../testing/fake-acp-agent";
import { accountGeminiRoot, addAccount, removeAccount } from "../accounts";
import { conversationTranscriptPath } from "../backfill";
import {
  createProvider,
  createRouterConnection,
  buildSettings,
  ACP_CAPABILITIES,
  CAPABILITIES,
  IMPLEMENT_PLAN_TEXT,
  childSessionId,
  childTurnId,
} from "../provider";
import type { AcpPromptResult } from "./schema";
import {
  createAcpConnection,
  type AcpConnectionOptions,
  type OneShotArgs,
  type OneShotResult,
  type OneShotRunner,
  toAcpMcpServers,
} from "./session";

describe("ACP Session & Connection (Phase 3a)", () => {
  let tempDir: string;
  let fakeAgent: FakeAcpAgent;
  let events: ProviderEvent[];
  let options: AcpConnectionOptions;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-session-test-"));
    fakeAgent = new FakeAcpAgent({ enableSteering: true });
    events = [];
    options = {
      transport: fakeAgent.clientTransport,
    };
  });

  afterEach(() => {
    fakeAgent.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
    return {
      cwd: tempDir,
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      ...overrides,
    };
  }

  function timelineItems(): ProviderTimelineItem[] {
    return events
      .filter((e): e is Extract<ProviderEvent, { type: "timeline.item" }> => e.type === "timeline.item")
      .map((e) => e.item);
  }

  function toolCallItems(): Extract<ProviderTimelineItem, { type: "tool_call" }>[] {
    return timelineItems().filter(
      (i): i is Extract<ProviderTimelineItem, { type: "tool_call" }> => i.type === "tool_call",
    );
  }

  async function waitForTurnCompletion(
    sessionId = "s1",
    turnId?: string,
    timeoutMs = 3000,
  ): Promise<Extract<ProviderEvent, { type: "session.turn" }>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const turns = events.filter(
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" &&
          e.sessionId === sessionId &&
          (e.state === "completed" || e.state === "failed" || e.state === "canceled"),
      );
      if (turnId) {
        const match = turns.find((t) => t.turnId === turnId);
        if (match) return match;
      } else if (turns.length > 0) {
        return turns[turns.length - 1];
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for turn completion in session ${sessionId}`);
  }

  it("Item 4: per-agent transport setting, router capabilities, and session routing", async () => {
    // 1. Setting row id "transport" exists in buildSettings
    const settings = buildSettings({
      accountId: "default",
      settings: {},
      selection: {},
    });
    const transportSetting = settings.find((s) => s.id === "transport");
    expect(transportSetting).toBeDefined();
    expect(transportSetting).toMatchObject({
      type: "select",
      id: "transport",
      value: "ndjson",
      options: [
        { label: "NDJSON (current)", value: "ndjson" },
        { label: "ACP (preview)", value: "acp" },
      ],
    });

    // 2. Router connection advertises union of capabilities
    const router = createRouterConnection(ACP_CAPABILITIES, { acpOptions: options });
    router.onEvent((e) => events.push(e));
    expect(router.capabilities).toContain("prompt.steer");

    // 3. Route to ACP via settings.transport = "acp"
    await router.send({
      type: "session.open",
      requestId: "r-acp",
      sessionId: "s-acp",
      config: makeConfig({ settings: { transport: "acp" } }),
      history: "skip",
    });

    const acpOpened = events.find((e) => e.type === "session.opened" && e.sessionId === "s-acp");
    expect(acpOpened).toBeDefined();
    expect((acpOpened as any).capabilities).toContain("prompt.steer");
    expect((acpOpened as any).persistence.data.transport).toBe("acp");

    // 4. Route to NDJSON via settings.transport = "ndjson"
    await router.send({
      type: "session.open",
      requestId: "r-ndjson",
      sessionId: "s-ndjson",
      config: makeConfig({ settings: { transport: "ndjson" } }),
      history: "skip",
    });

    const ndjsonOpened = events.find((e) => e.type === "session.opened" && e.sessionId === "s-ndjson");
    expect(ndjsonOpened).toBeDefined();
    expect((ndjsonOpened as any).capabilities).not.toContain("prompt.steer");
    expect((ndjsonOpened as any).persistence.data.transport).toBeUndefined();

    // 5. Changing transport on open ACP session emits notice and keeps current transport
    await router.send({
      type: "session.configure",
      requestId: "r-cfg",
      sessionId: "s-acp",
      changes: {
        settings: { transport: "ndjson" },
      },
    });

    const notice = events.find(
      (e) => e.type === "session.notice" && e.sessionId === "s-acp" && e.notice.id === "transport-change-unsupported",
    );
    expect(notice).toBeDefined();

    // 6. Resuming with old persistence (no transport) stays on NDJSON
    await router.send({
      type: "session.open",
      requestId: "r-res-old",
      sessionId: "s-res-old",
      config: makeConfig(),
      persistence: {
        version: 1,
        data: { conversationId: "old-conv-id", accountId: "default" },
      },
      history: "skip",
    });

    const resOldOpened = events.find((e) => e.type === "session.opened" && e.sessionId === "s-res-old");
    expect((resOldOpened as any).persistence.data.transport).toBeUndefined();

    await router.close();
  });

  it("Item 2: lazy start: open does NOT spawn process; first prompt initializes and emits persistence", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig({ systemPrompt: "System instructions" }),
      history: "skip",
    });

    // Lazy: NO process requests yet!
    expect(fakeAgent.requestsFor("initialize")).toHaveLength(0);
    expect(fakeAgent.requestsFor("session/new")).toHaveLength(0);

    const opened = events.find((e) => e.type === "session.opened");
    expect(opened).toMatchObject({
      type: "session.opened",
      requestId: "r1",
      sessionId: "s1",
      persistence: {
        version: 1,
        data: {
          conversationId: null,
          accountId: "default",
          transport: "acp",
        },
      },
    });

    expect(events.some((e) => e.type === "session.config")).toBe(true);
    expect(events.some((e) => e.type === "session.commands")).toBe(true);
    expect(events.some((e) => e.type === "session.ready")).toBe(true);

    // Now send the first prompt -> triggers initialize and session/new
    fakeAgent.queuePromptResult({
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 10 },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Hello first prompt" }],
        },
      },
    });

    await waitForTurnCompletion("s1");

    // Initialized on demand
    expect(fakeAgent.requestsFor("initialize")).toHaveLength(1);
    const newReqs = fakeAgent.requestsFor("session/new");
    expect(newReqs).toHaveLength(1);
    expect(newReqs[0].params).toMatchObject({
      cwd: tempDir,
      mcpServers: [],
      _meta: {
        antigravity: {
          systemPrompt: {
            append: "System instructions",
          },
        },
      },
    });

    // Persistence emitted on first launch
    const persistenceEvent = events.find((e) => e.type === "session.persistence");
    expect(persistenceEvent).toMatchObject({
      type: "session.persistence",
      sessionId: "s1",
      persistence: {
        version: 1,
        data: {
          conversationId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
          accountId: "default",
          transport: "acp",
        },
      },
    });

    await connection.close();
  });

  it("Item 2: resume session initializes and calls session/resume on first prompt", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig({ systemPrompt: "Resumed prompt" }),
      persistence: {
        version: 1,
        data: {
          conversationId: "existing-uuid-1234",
          accountId: "default",
          transport: "acp",
        },
      },
      history: "skip",
    });

    // Lazy: not spawned yet
    expect(fakeAgent.requestsFor("session/resume")).toHaveLength(0);

    // First prompt spawns and calls session/resume
    fakeAgent.queuePromptResult({
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 10 },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Resume turn" }],
        },
      },
    });

    await waitForTurnCompletion("s1");

    const resumeReqs = fakeAgent.requestsFor("session/resume");
    expect(resumeReqs).toHaveLength(1);
    expect(resumeReqs[0].params).toMatchObject({
      sessionId: "existing-uuid-1234",
      cwd: tempDir,
      mcpServers: [],
      _meta: {
        antigravity: {
          systemPrompt: {
            append: "Resumed prompt",
          },
        },
      },
    });

    await connection.close();
  });

  it("Item 1: non-blocking send(): awaits send(prompt), then sends delivery:steer and session.interrupt mid-turn", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    // Hold prompt so turn stays pending until interrupted
    fakeAgent.holdPrompt();

    // 1. send(prompt) must NOT block for the turn!
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "p1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Initial long turn" }],
        },
      },
    });

    // send() resolved immediately and admitted the turn
    const turnResult = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "p1");
    expect(turnResult).toMatchObject({
      result: { type: "turn" },
    });
    const turnStarted = events.find((e) => e.type === "session.turn" && e.state === "started");
    expect(turnStarted).toBeDefined();

    // Give prompt a moment to spawn client and start turn
    await new Promise((r) => setTimeout(r, 30));

    // 2. While prompt 1 is still pending, send steer prompt
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "p2",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "Steering prompt" }],
        },
      },
    });

    const steerResult = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "p2");
    expect(steerResult).toMatchObject({
      result: { type: "steer" },
    });

    // 3. Send session.interrupt while prompt is running
    await connection.send({
      type: "session.interrupt",
      requestId: "r-int",
      sessionId: "s1",
    });

    const finalTurn = await waitForTurnCompletion("s1");
    expect(finalTurn.state).toBe("canceled");

    expect(fakeAgent.notificationsFor("session/cancel")).toHaveLength(1);
    await connection.close();
  });

  it("Item 3: open tool rows when turn ends: finished-but-backgrounded tools get completed status and note", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    fakeAgent.setPromptHandler(() => {
      fakeAgent.emitToolCall("s1", "bg-tool", "in_progress", {
        name: "run_command",
        args: { CommandLine: "npm run dev", Cwd: tempDir },
      });
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Start dev server" }],
        },
      },
    });

    await waitForTurnCompletion("s1");

    const toolItems = toolCallItems().filter((i) => i.callId === "bg-tool");
    expect(toolItems).toHaveLength(2);
    // Final tool row status must be completed, with note appended to output
    expect(toolItems[1]).toMatchObject({
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: "npm run dev",
      },
    });
    expect((toolItems[1].detail as any).output).toContain(
      "Still running in the background when the turn ended — Antigravity sees its result on your next message.",
    );

    await connection.close();
  });

  it("streaming: streams agent_message_chunk and agent_thought_chunk, ignores user_message_chunk", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    fakeAgent.setPromptHandler((params) => {
      fakeAgent.emitChunk("s1", "Echoed user", "user_message_chunk");
      fakeAgent.emitChunk("s1", "Thinking 1 ", "agent_thought_chunk");
      fakeAgent.emitChunk("s1", "Thinking 2", "agent_thought_chunk");
      fakeAgent.emitChunk("s1", "Hello ", "agent_message_chunk");
      fakeAgent.emitChunk("s1", "world!", "agent_message_chunk");
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Say hello" }],
        },
      },
    });

    await waitForTurnCompletion("s1");
    const items = timelineItems();

    // User message
    const userMsg = items.find((i) => i.type === "user_message");
    expect(userMsg).toMatchObject({
      type: "user_message",
      text: "Say hello",
      clientMessageId: "m1",
    });

    // Ignored user message chunk: should NOT produce any extra user message
    const userMessages = items.filter((i) => i.type === "user_message");
    expect(userMessages).toHaveLength(1);

    // Thoughts
    const thoughts = items.filter((i) => i.type === "reasoning");
    expect(thoughts.length).toBeGreaterThanOrEqual(2);
    expect(thoughts.at(-1)).toMatchObject({
      type: "reasoning",
      text: "Thinking 1 Thinking 2",
    });

    // Messages
    const messages = items.filter((i) => i.type === "assistant_message");
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.at(-1)).toMatchObject({
      type: "assistant_message",
      text: "Hello world!",
    });

    await connection.close();
  });

  it("tool rows: vendor-name path, fallback path, diff content, and status transitions", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    fakeAgent.setPromptHandler(() => {
      // 1. Vendor tool call: run_command
      fakeAgent.emitToolCall("s1", "call-cmd", "in_progress", {
        name: "run_command",
        args: { CommandLine: "ls -la", Cwd: tempDir },
      });
      fakeAgent.emitToolCall("s1", "call-cmd", "completed", {
        name: "run_command",
        args: { CommandLine: "ls -la", Cwd: tempDir },
        rawOutput: "file1.txt\nfile2.txt",
      });

      // 2. Fallback ACP tool call: edit diff
      fakeAgent.emitToolCall("s1", "call-diff", "in_progress", {
        kind: "edit",
        title: "Edit foo.ts",
        content: [
          {
            type: "diff",
            path: "foo.ts",
            oldText: "const x = 1;",
            newText: "const x = 2;",
          },
        ],
      });
      fakeAgent.emitToolCall("s1", "call-diff", "completed", {
        kind: "edit",
        title: "Edit foo.ts",
      });

      return {
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Run tools" }],
        },
      },
    });

    await waitForTurnCompletion("s1");
    const toolItems = toolCallItems();

    // Vendor tool call
    const cmdTools = toolItems.filter((i) => i.callId === "call-cmd");
    expect(cmdTools).toHaveLength(2);
    expect(cmdTools[0]).toMatchObject({
      status: "running",
      detail: {
        type: "shell",
        command: "ls -la",
      },
    });
    expect(cmdTools[1]).toMatchObject({
      status: "completed",
      detail: {
        type: "shell",
        command: "ls -la",
        output: "file1.txt\nfile2.txt",
      },
    });

    // Fallback tool call
    const diffTools = toolItems.filter((i) => i.callId === "call-diff");
    expect(diffTools).toHaveLength(2);
    expect(diffTools[0]).toMatchObject({
      status: "running",
      detail: {
        type: "edit",
        filePath: "foo.ts",
        oldString: "const x = 1;",
        newString: "const x = 2;",
      },
    });
    expect(diffTools[1]).toMatchObject({
      status: "completed",
    });

    await connection.close();
  });

  it("usage: maps inputTokens, cachedReadTokens, and outputTokens + thoughtTokens", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    fakeAgent.queuePromptResult({
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        cachedReadTokens: 40,
        outputTokens: 50,
        thoughtTokens: 25,
      },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Usage check" }],
        },
      },
    });

    await waitForTurnCompletion("s1");

    const usageEvent = events.find((e) => e.type === "session.usage");
    expect(usageEvent).toBeDefined();
    expect(usageEvent).toMatchObject({
      type: "session.usage",
      sessionId: "s1",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 75, // 50 + 25
      },
    });

    await connection.close();
  });

  it("cancel / interrupt: cancels open tool rows and settles turn as canceled", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    fakeAgent.holdPrompt();

    fakeAgent.setPromptHandler(async () => {
      fakeAgent.emitToolCall("s1", "open-tool", "in_progress", {
        name: "run_command",
        args: { CommandLine: "sleep 10" },
      });
      return new Promise(() => {});
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Long turn" }],
        },
      },
    });

    // Wait a tick for tool call to arrive
    await new Promise((r) => setTimeout(r, 20));

    // Send interrupt
    await connection.send({
      type: "session.interrupt",
      requestId: "req-int",
      sessionId: "s1",
    });

    await waitForTurnCompletion("s1");

    expect(fakeAgent.notificationsFor("session/cancel")).toHaveLength(1);

    const toolItems = toolCallItems().filter((i) => i.callId === "open-tool");
    expect(toolItems).toHaveLength(2);
    expect(toolItems[1]).toMatchObject({
      status: "canceled",
      error: null,
    });

    const turnEvents = events.filter((e) => e.type === "session.turn");
    expect(turnEvents.at(-1)).toMatchObject({
      state: "canceled",
    });

    await connection.close();
  });

  it("steering: returns steer result, sends second prompt, ignores superseded end_turn, completes on second", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    fakeAgent.holdPrompt();

    fakeAgent.setPromptHandler(async (params, id) => {
      if (id === 3) {
        // First session/prompt
        fakeAgent.emitChunk("s1", "Starting turn 1...", "agent_message_chunk");
        return new Promise<AcpPromptResult>((resolve) => {
          setTimeout(() => {
            resolve({ stopReason: "end_turn" });
          }, 30);
        });
      } else {
        // Second session/prompt (steering)
        fakeAgent.emitChunk("s1", "Steered turn reply!", "agent_message_chunk");
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 50, outputTokens: 80 },
        };
      }
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "First prompt" }],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Send steering prompt
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m2",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "Please do this instead" }],
        },
      },
    });

    const finalTurn = await waitForTurnCompletion("s1");
    expect(finalTurn.state).toBe("completed");

    // Steer prompt result was admitted with type: "steer"
    const steerResult = events.find(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "m2",
    );
    expect(steerResult).toMatchObject({
      result: { type: "steer" },
    });

    // Exactly ONE turn completed
    const turnCompletions = events.filter((e) => e.type === "session.turn" && e.state === "completed");
    expect(turnCompletions).toHaveLength(1);

    // Final usage from second prompt
    const usage = events.find((e) => e.type === "session.usage");
    expect(usage).toMatchObject({
      usage: { inputTokens: 50, outputTokens: 80 },
    });

    await connection.close();
  });

  it("configure: pre-prompt configuration applied on first launch without restart", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    // Change configuration before client is spawned
    await connection.send({
      type: "session.configure",
      requestId: "rc1",
      sessionId: "s1",
      changes: {
        mode: "accept-edits",
        model: "gemini-3.8-flash-low",
        thinkingOption: "low",
      },
    });

    const cfgEvent = events.filter((e) => e.type === "session.config").at(-1);
    expect(cfgEvent).toMatchObject({
      config: {
        model: "gemini-3.8-flash-low",
        mode: "accept-edits",
        thinkingOption: "low",
      },
    });

    // Now send first prompt -> spawns client and applies configuration options
    fakeAgent.queuePromptResult({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Configure test" }],
        },
      },
    });

    await waitForTurnCompletion("s1");

    const modeReqs = fakeAgent.requestsFor("session/set_mode");
    expect(modeReqs).toHaveLength(1);
    expect(modeReqs[0].params).toEqual({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      modeId: "accept-edits",
    });

    const optReqs = fakeAgent.requestsFor("session/set_config_option");
    expect(optReqs.length).toBeGreaterThanOrEqual(2);
    expect(optReqs.some((r) => (r.params as any).configId === "model" && (r.params as any).value === "gemini-3.8-flash-low")).toBe(true);
    expect(optReqs.some((r) => (r.params as any).configId === "thought_level" && (r.params as any).value === "low")).toBe(true);

    await connection.close();
  });

  it("slash commands: merges available_commands_update with system commands, keeping duplicate SKILL names", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    fakeAgent.setPromptHandler(() => {
      fakeAgent.emitSessionUpdate("s1", {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "SKILL", description: "First duplicate skill" },
          { name: "SKILL", description: "Second duplicate skill" },
          { name: "unique_tool", description: "A unique tool" },
        ],
      });
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Commands test" }],
        },
      },
    });

    await waitForTurnCompletion("s1");

    const cmdEvents = events.filter((e) => e.type === "session.commands");
    expect(cmdEvents.length).toBeGreaterThanOrEqual(2);
    const lastCmds = (cmdEvents.at(-1) as any).commands;

    // Both duplicate skills kept with deduplicated display names
    const skillCmds = lastCmds.filter((c: any) => c.name.startsWith("SKILL"));
    expect(skillCmds).toHaveLength(2);
    expect(skillCmds[0].name).toBe("SKILL");
    expect(skillCmds[1].name).toBe("SKILL (2)");

    // System commands preserved
    expect(lastCmds.some((c: any) => c.name === "compact")).toBe(true);
    expect(lastCmds.some((c: any) => c.name === "plan")).toBe(true);

    await connection.close();
  });

  it("crash recovery: fails running turn, then next prompt relaunches and resumes session", async () => {
    let currentAgent = fakeAgent;
    const dynamicTransport: AcpConnectionOptions["transport"] = {
      get input() {
        return currentAgent.clientTransport.input;
      },
      get output() {
        return currentAgent.clientTransport.output;
      },
    };

    const connection = createAcpConnection(ACP_CAPABILITIES, { transport: dynamicTransport });
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    currentAgent.holdPrompt();
    currentAgent.setPromptHandler(async () => {
      currentAgent.emitToolCall("s1", "running-cmd", "in_progress", {
        name: "run_command",
        args: { CommandLine: "long running process" },
      });
      return new Promise(() => {});
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Turn 1 will crash" }],
        },
      },
    });

    const p1Result = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "m1");
    const turn1Id = (p1Result as any)?.result?.turnId;

    await new Promise((r) => setTimeout(r, 20));

    // Agent crashes
    currentAgent.crash(new Error("Process crashed suddenly"));
    await waitForTurnCompletion("s1", turn1Id);

    // Running tool failed
    const toolItems = toolCallItems().filter((i) => i.callId === "running-cmd");
    expect(toolItems.at(-1)).toMatchObject({ status: "failed" });

    // Turn 1 failed
    const turn1Fail = events.find((e) => e.type === "session.turn" && e.state === "failed");
    expect(turn1Fail).toBeDefined();

    // Spawn replacement agent for next prompt
    const agent2 = new FakeAcpAgent({ enableSteering: true });
    currentAgent = agent2;

    agent2.queuePromptResult({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 15 },
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m2",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Turn 2 after recovery" }],
        },
      },
    });

    const p2Result = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "m2");
    const turn2Id = (p2Result as any)?.result?.turnId;
    await waitForTurnCompletion("s1", turn2Id);

    // Agent 2 was initialized and resumed the existing conversation!
    expect(agent2.requestsFor("initialize")).toHaveLength(1);
    expect(agent2.requestsFor("session/resume")).toHaveLength(1);
    expect(agent2.requestsFor("session/resume")[0].params).toMatchObject({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
    });

    agent2.close();
    await connection.close();
  });

  it("Item 5: minor: session.permission completes with session.permission_resolved", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "perm-123",
      response: { behavior: "allow" },
    });

    const resolved = events.find(
      (e) => e.type === "session.permission_resolved" && e.permissionId === "perm-123",
    );
    expect(resolved).toBeDefined();

    await connection.close();
  });

  it("structured output refusal: cleanly refuses non-object outputSchema on ACP sessions", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Output JSON" }],
        },
        outputSchema: {
          type: "array",
          items: { type: "string" },
        },
      },
    });

    const res = events.find((e) => e.type === "session.prompt_result");
    expect(res).toMatchObject({
      type: "session.prompt_result",
      clientMessageId: "m1",
      result: {
        type: "failed",
        error: {
          code: "schema_unsupported",
        },
      },
    });

    await connection.close();
  });

  it("can_stop_runtime: reports false while turn is active, true when idle", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    // Idle
    await connection.send({
      type: "session.can_stop_runtime",
      requestId: "req-stop-1",
      sessionId: "s1",
    });

    const stop1 = events.find((e) => e.type === "session.can_stop_runtime" && e.requestId === "req-stop-1");
    expect(stop1).toMatchObject({ canStop: true });

    // Active turn
    fakeAgent.holdPrompt();
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Hold turn" }],
        },
      },
    });

    await connection.send({
      type: "session.can_stop_runtime",
      requestId: "req-stop-2",
      sessionId: "s1",
    });

    const stop2 = events.find((e) => e.type === "session.can_stop_runtime" && e.requestId === "req-stop-2");
    expect(stop2).toMatchObject({ canStop: false });

    // Resolve prompt
    fakeAgent.resolveHeldPrompt();
    await waitForTurnCompletion("s1");

    await connection.close();
  });

  it("close: closes session and underlying client cleanly", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    // Spawn client via first prompt
    fakeAgent.queuePromptResult({ stopReason: "end_turn" });
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Turn to spawn" }],
        },
      },
    });
    await waitForTurnCompletion("s1");

    await connection.send({
      type: "session.close",
      requestId: "req-close",
      sessionId: "s1",
    });

    expect(fakeAgent.requestsFor("session/close")).toHaveLength(1);
    expect(events.some((e) => e.type === "session.closed" && e.sessionId === "s1")).toBe(true);
    expect(events.some((e) => e.type === "request.completed" && e.requestId === "req-close")).toBe(true);

    await connection.close();
  });
});

describe("ACP Cards & Interactive Flows (Phase 3b)", () => {
  let tempDir: string;
  let fakeAgent: FakeAcpAgent;
  let events: ProviderEvent[];
  let options: AcpConnectionOptions;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-cards-test-"));
    fakeAgent = new FakeAcpAgent({ enableSteering: true });
    events = [];
    options = {
      transport: fakeAgent.clientTransport,
    };
  });

  afterEach(() => {
    fakeAgent.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
    return {
      cwd: tempDir,
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      ...overrides,
    };
  }

  function permissions(): Extract<ProviderEvent, { type: "session.permission" }>[] {
    return events.filter(
      (e): e is Extract<ProviderEvent, { type: "session.permission" }> => e.type === "session.permission",
    );
  }

  function resolvedPermissions(): Extract<ProviderEvent, { type: "session.permission_resolved" }>[] {
    return events.filter(
      (e): e is Extract<ProviderEvent, { type: "session.permission_resolved" }> =>
        e.type === "session.permission_resolved",
    );
  }

  function timelineItems(): ProviderTimelineItem[] {
    return events
      .filter((e): e is Extract<ProviderEvent, { type: "timeline.item" }> => e.type === "timeline.item")
      .map((e) => e.item);
  }

  async function waitFor<T>(predicate: () => T | undefined, label: string, timeoutMs = 3000): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = predicate();
      if (val !== undefined) return val;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function waitForTurnCompletion(
    sessionId = "s1",
    turnId?: string,
    timeoutMs = 3000,
  ): Promise<Extract<ProviderEvent, { type: "session.turn" }>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const turns = events.filter(
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" &&
          e.sessionId === sessionId &&
          (e.state === "completed" || e.state === "failed" || e.state === "canceled"),
      );
      if (turnId) {
        const match = turns.find((t) => t.turnId === turnId);
        if (match) return match;
      } else if (turns.length > 0) {
        return turns[turns.length - 1];
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for turn completion in session ${sessionId}`);
  }

  it("permission allow: maps request_permission onto Paseo permission request and resolves allow_once on allow", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let recordedOutcome: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      fakeAgent.emitToolCall(sessionId, "call_275190", "pending", {
        name: "write_file",
        args: { Content: "hi\n", Path: "/private/tmp/x/hello.txt" },
        kind: "edit",
        title: "File hello.txt",
        locations: [{ path: "/private/tmp/x/hello.txt" }],
      });

      const outcome = await fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_275190",
          name: "write_file",
          args: { Content: "hi\n", Path: "/private/tmp/x/hello.txt" },
          status: "pending",
          kind: "edit",
          title: "File hello.txt",
          locations: [{ path: "/private/tmp/x/hello.txt" }],
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });

      recordedOutcome = outcome;
      fakeAgent.emitToolCall(sessionId, "call_275190", "completed");
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Create file" }],
        },
      },
    });

    const permReq = await waitFor(() => permissions()[0], "permission request");
    expect(permReq.request).toMatchObject({
      id: "call_275190",
      kind: "tool",
      name: "write_file",
      detail: expect.objectContaining({ type: "edit" }),
      actions: [
        expect.objectContaining({ id: "allow", behavior: "allow" }),
        expect.objectContaining({ id: "deny", behavior: "deny" }),
      ],
    });

    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: permReq.request.id,
      response: { behavior: "allow", selectedActionId: "allow" },
    });

    await waitFor(() => resolvedPermissions()[0], "permission resolved");
    await waitForTurnCompletion("s1");

    expect(recordedOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await connection.close();
  });

  it("permission deny: resolves reject_once on deny", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let recordedOutcome: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      fakeAgent.emitToolCall(sessionId, "call_275190", "pending", {
        name: "write_file",
        args: { Content: "hi\n", Path: "/private/tmp/x/hello.txt" },
      });

      const outcome = await fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_275190",
          name: "write_file",
          args: { Content: "hi\n", Path: "/private/tmp/x/hello.txt" },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });

      recordedOutcome = outcome;
      fakeAgent.emitToolCall(sessionId, "call_275190", "failed");
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Create file" }],
        },
      },
    });

    const permReq = await waitFor(() => permissions()[0], "permission request");
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: permReq.request.id,
      response: { behavior: "deny" },
    });

    await waitFor(() => resolvedPermissions()[0], "permission resolved");
    await waitForTurnCompletion("s1");

    expect(recordedOutcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    await connection.close();
  });

  it("permission always: resolves allow_always or reject_always when offered and chosen", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let recordedOutcome: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      const outcome = await fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_275190",
          name: "run_command",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
          { optionId: "reject_always", name: "Never Allow", kind: "reject_always" },
        ],
      });

      recordedOutcome = outcome;
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Run command" }],
        },
      },
    });

    const permReq = await waitFor(() => permissions()[0], "permission request");
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: permReq.request.id,
      response: { behavior: "allow", selectedActionId: "allow_always" },
    });

    await waitFor(() => resolvedPermissions()[0], "permission resolved");
    await waitForTurnCompletion("s1");

    expect(recordedOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow_always" } });
    await connection.close();
  });

  it("multiple pending permissions: tracks and resolves independent requests", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    const outcomes: any[] = [];

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      const p1 = fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          name: "write_file",
        },
        options: [
          { optionId: "opt_allow_1", name: "Allow", kind: "allow_once" },
          { optionId: "opt_deny_1", name: "Deny", kind: "reject_once" },
        ],
      });

      const p2 = fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          name: "run_command",
        },
        options: [
          { optionId: "opt_allow_2", name: "Allow", kind: "allow_once" },
          { optionId: "opt_deny_2", name: "Deny", kind: "reject_once" },
        ],
      });

      const res = await Promise.all([p1, p2]);
      outcomes.push(...res);
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Multi permissions" }],
        },
      },
    });

    await waitFor(() => (permissions().length === 2 ? true : undefined), "both permission requests");
    expect(permissions().map((p) => p.request.id)).toEqual(["call_1", "call_2"]);

    // Resolve call_1 first
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "call_1",
      response: { behavior: "allow" },
    });

    await waitFor(
      () => (resolvedPermissions().some((r) => r.permissionId === "call_1") ? true : undefined),
      "call_1 resolved",
    );
    expect(outcomes).toHaveLength(0); // call_2 is still waiting!

    // Now resolve call_2
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "call_2",
      response: { behavior: "deny" },
    });

    await waitFor(
      () => (resolvedPermissions().some((r) => r.permissionId === "call_2") ? true : undefined),
      "call_2 resolved",
    );
    await waitForTurnCompletion("s1");

    expect(outcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "opt_allow_1" } },
      { outcome: { outcome: "selected", optionId: "opt_deny_2" } },
    ]);
    await connection.close();
  });

  it("permission cancelled on interrupt: resolves outcome cancelled and clears card", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let outcomePromise: Promise<any> | null = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      outcomePromise = fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_interrupt",
          name: "write_file",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      return { stopReason: "cancelled" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Interrupt test" }],
        },
      },
    });

    await waitFor(() => permissions()[0], "permission request");

    await connection.send({
      type: "session.interrupt",
      requestId: "req-int",
      sessionId: "s1",
    });

    const outcome = await outcomePromise;
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
    expect(resolvedPermissions().some((r) => r.permissionId === "call_interrupt")).toBe(true);
    await connection.close();
  });

  it("permission cancelled on close: resolves outcome cancelled and clears card", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let outcomePromise: Promise<any> | null = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      outcomePromise = fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_close",
          name: "write_file",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      return { stopReason: "cancelled" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Close test" }],
        },
      },
    });

    await waitFor(() => permissions()[0], "permission request");

    await connection.send({
      type: "session.close",
      requestId: "req-close",
      sessionId: "s1",
    });

    const outcome = await outcomePromise;
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
    expect(resolvedPermissions().some((r) => r.permissionId === "call_close")).toBe(true);
    await connection.close();
  });

  it("skip policy auto-allow: auto-allows without card when approvalPolicy is skip", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig({ settings: { approvalPolicy: "skip" } }),
      history: "skip",
    });

    let outcomeResult: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      const outcome = await fakeAgent.requestPermission({
        sessionId,
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: "call_skip",
          name: "write_file",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      outcomeResult = outcome;
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Auto allow prompt" }],
        },
      },
    });

    await waitForTurnCompletion("s1");
    expect(permissions()).toHaveLength(0); // No card emitted!
    expect(outcomeResult).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await connection.close();
  });

  it("question single-select: renders question card and responds with const", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let elicitationOutcome: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      fakeAgent.emitToolCall(sessionId, "call_175877", "pending", {
        name: "ask_question",
        args: {
          questions: [
            {
              question: "Which color do you prefer?",
              options: ["Red", "Blue"],
              is_multi_select: false,
            },
          ],
        },
      });

      const outcome = await fakeAgent.createElicitation({
        sessionId,
        toolCallId: "call_175877",
        mode: "form",
        message: "The agent has a question.",
        requestedSchema: {
          type: "object",
          properties: {
            q1: {
              type: "string",
              title: "Which color do you prefer?",
              oneOf: [
                { const: "1", title: "(Recommended) Red" },
                { const: "2", title: "Blue" },
              ],
            },
            q1_other: {
              type: "string",
              title: "Other",
              description: "Optional free-form answer to: Which color do you prefer?",
            },
          },
        },
      });

      elicitationOutcome = outcome;
      fakeAgent.emitToolCall(sessionId, "call_175877", "completed");
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Ask me a question" }],
        },
      },
    });

    const questionCard = await waitFor(() => permissions()[0], "question card");
    expect(questionCard.request).toMatchObject({
      id: "question:call_175877",
      kind: "question",
      name: "ask_question",
      title: "Which color do you prefer?",
    });

    // Check brain icon tool row emitted
    const brainRows = timelineItems().filter(
      (item): item is Extract<ProviderTimelineItem, { type: "tool_call" }> =>
        item.type === "tool_call" && item.name === "ask_question",
    );
    expect(brainRows.length).toBeGreaterThan(0);
    expect((brainRows[0].detail as any)?.icon).toBe("brain");

    // User answers "Blue"
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: questionCard.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "Question 1": "Blue" } },
      },
    });

    await waitFor(() => resolvedPermissions()[0], "question card resolved");
    await waitForTurnCompletion("s1");

    expect(elicitationOutcome).toEqual({
      action: "accept",
      content: { q1: "2" },
    });

    // Tool row updated with answered text
    const updatedBrainRows = timelineItems().filter(
      (item): item is Extract<ProviderTimelineItem, { type: "tool_call" }> =>
        item.type === "tool_call" && item.name === "ask_question",
    );
    expect((updatedBrainRows.at(-1)?.detail as any)?.text).toContain("Which color do you prefer?\nBlue");
    await connection.close();
  });

  it("question multi-select: responds with array of consts", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let elicitationOutcome: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      fakeAgent.emitToolCall(sessionId, "call_multi", "pending", {
        name: "ask_question",
        args: {
          questions: [
            {
              question: "Which fruits do you like?",
              options: ["Apple", "Pear", "Plum"],
              is_multi_select: true,
            },
          ],
        },
      });

      const outcome = await fakeAgent.createElicitation({
        sessionId,
        toolCallId: "call_multi",
        mode: "form",
        message: "The agent has a question.",
        requestedSchema: {
          type: "object",
          properties: {
            q1: {
              type: "array",
              title: "Which fruits do you like?",
              items: {
                anyOf: [
                  { const: "1", title: "Apple" },
                  { const: "2", title: "Pear" },
                  { const: "3", title: "Plum" },
                ],
              },
            },
          },
        },
      });

      elicitationOutcome = outcome;
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Fruits" }],
        },
      },
    });

    const card = await waitFor(() => permissions()[0], "multi-select card");
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: card.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "Question 1": "Apple, Plum" } },
      },
    });

    await waitForTurnCompletion("s1");
    expect(elicitationOutcome).toEqual({
      action: "accept",
      content: { q1: ["1", "3"] },
    });
    await connection.close();
  });

  it("question free-text other: responds with q1_other", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let elicitationOutcome: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      const outcome = await fakeAgent.createElicitation({
        sessionId,
        toolCallId: "call_freetext",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            q1: {
              type: "string",
              title: "Which color do you prefer?",
              oneOf: [{ const: "1", title: "Red" }],
            },
            q1_other: {
              type: "string",
              title: "Other",
            },
          },
        },
      });

      elicitationOutcome = outcome;
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Color" }],
        },
      },
    });

    const card = await waitFor(() => permissions()[0], "card");
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: card.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { "Question 1": "Purple" } },
      },
    });

    await waitForTurnCompletion("s1");
    expect(elicitationOutcome).toEqual({
      action: "accept",
      content: { q1_other: "Purple" },
    });
    await connection.close();
  });

  it("question skip: responds with empty content on deny / dismiss", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let elicitationOutcome: any = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      fakeAgent.emitToolCall(sessionId, "call_skip", "pending", {
        name: "ask_question",
        args: { questions: [{ question: "Skip me?", options: ["Yes", "No"], is_multi_select: false }] },
      });

      const outcome = await fakeAgent.createElicitation({
        sessionId,
        toolCallId: "call_skip",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            q1: { type: "string", title: "Skip me?", oneOf: [{ const: "1", title: "Yes" }] },
          },
        },
      });

      elicitationOutcome = outcome;
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Skip prompt" }],
        },
      },
    });

    const card = await waitFor(() => permissions()[0], "card");
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: card.request.id,
      response: { behavior: "deny" },
    });

    await waitForTurnCompletion("s1");
    expect(elicitationOutcome).toEqual({
      action: "accept",
      content: {},
    });

    const brainRows = timelineItems().filter(
      (item): item is Extract<ProviderTimelineItem, { type: "tool_call" }> =>
        item.type === "tool_call" && item.name === "ask_question",
    );
    expect((brainRows.at(-1)?.detail as any)?.text).toContain("Dismissed");
    await connection.close();
  });

  it("question cancel on interrupt: responds with cancel on interrupt", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig(),
      history: "skip",
    });

    let elicitationPromise: Promise<any> | null = null;

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      elicitationPromise = fakeAgent.createElicitation({
        sessionId,
        toolCallId: "call_q_int",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            q1: { type: "string", title: "Wait for me?", oneOf: [{ const: "1", title: "Yes" }] },
          },
        },
      });
      return { stopReason: "cancelled" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Interrupt prompt" }],
        },
      },
    });

    await waitFor(() => permissions()[0], "card");
    await connection.send({
      type: "session.interrupt",
      requestId: "req-int",
      sessionId: "s1",
    });

    const outcome = await elicitationPromise;
    expect(outcome).toEqual({ action: "cancel" });
    expect(resolvedPermissions().some((r) => r.permissionId === "question:call_q_int")).toBe(true);
    await connection.close();
  });

  it("plan card from RequestFeedback write_file in plan mode", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig({ mode: "plan" }),
      history: "skip",
    });

    fakeAgent.setPromptHandler(async ({ sessionId }) => {
      fakeAgent.emitToolCall(sessionId, "call_plan_write", "pending", {
        name: "write_file",
        args: {
          Path: "/Users/test/.gemini/antigravity-cli/brain/123/plan.md",
          Content: "# Concrete Plan\n1. Modify client\n2. Add tests",
          ArtifactMetadata: { RequestFeedback: true, Summary: "Add tests" },
        },
      });
      fakeAgent.emitToolCall(sessionId, "call_plan_write", "completed", {
        name: "write_file",
        args: {
          Path: "/Users/test/.gemini/antigravity-cli/brain/123/plan.md",
          Content: "# Concrete Plan\n1. Modify client\n2. Add tests",
          ArtifactMetadata: { RequestFeedback: true, Summary: "Add tests" },
        },
      });
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Create plan" }],
        },
      },
    });

    const planCard = await waitFor(() => permissions()[0], "plan card");
    expect(planCard.request).toMatchObject({
      kind: "plan",
      name: "plan",
      title: "Implement this plan?",
      detail: { type: "plan", text: "# Concrete Plan\n1. Modify client\n2. Add tests" },
      actions: [
        expect.objectContaining({ id: "implement", behavior: "allow", intent: "implement" }),
        expect.objectContaining({ id: "dismiss", behavior: "deny", intent: "dismiss" }),
      ],
    });
    await waitForTurnCompletion("s1");
    await connection.close();
  });

  it("implement flow (set_mode + prompt): switches mode to accept-edits and sends IMPLEMENT_PLAN_TEXT", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig({ mode: "plan" }),
      history: "skip",
    });

    fakeAgent.setPromptHandler(async ({ sessionId, prompt }) => {
      const text = (prompt[0] as any)?.text;
      if (text === IMPLEMENT_PLAN_TEXT) {
        return { stopReason: "end_turn" };
      }

      fakeAgent.emitToolCall(sessionId, "call_plan_write", "completed", {
        name: "write_file",
        args: {
          Content: "# Plan to implement",
          ArtifactMetadata: { RequestFeedback: true },
        },
      });
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Plan something" }],
        },
      },
    });

    const planCard = await waitFor(() => permissions()[0], "plan card");
    await waitForTurnCompletion("s1");

    // Approve the plan
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: planCard.request.id,
      response: { behavior: "allow", selectedActionId: "implement" },
    });

    // Wait for the implementing turn to complete
    await waitFor(
      () => (events.filter((e) => e.type === "session.turn" && e.state === "completed")[1] ? true : undefined),
      "implementing turn",
    );

    // 1. set_mode called with accept-edits
    const setModeReqs = fakeAgent.requestsFor("session/set_mode");
    expect(setModeReqs.some((r) => (r.params as any).modeId === "accept-edits")).toBe(true);

    // 2. session.config emitted with accept-edits
    const configEvents = events.filter((e) => e.type === "session.config");
    expect((configEvents.at(-1) as any)?.config.mode).toBe("accept-edits");

    // 3. Implementing prompt sent
    const promptReqs = fakeAgent.requestsFor("session/prompt");
    expect(promptReqs).toHaveLength(2);
    expect((promptReqs[1].params as any).prompt[0].text).toBe(IMPLEMENT_PLAN_TEXT);

    await connection.close();
  });

  it("/plan command: switches mode to plan, prompts argument, and restores original mode on implement", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig({ mode: "default" }),
      history: "skip",
    });

    fakeAgent.setPromptHandler(async ({ sessionId, prompt }) => {
      const text = (prompt[0] as any)?.text;
      if (text === IMPLEMENT_PLAN_TEXT) {
        return { stopReason: "end_turn" };
      }

      fakeAgent.emitToolCall(sessionId, "call_plan_write", "completed", {
        name: "write_file",
        args: {
          Content: "# Plan from /plan command",
          ArtifactMetadata: { RequestFeedback: true },
        },
      });
      return { stopReason: "end_turn" };
    });

    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "command",
          name: "plan",
          arguments: "add a cache layer",
        },
      },
    });

    // Verify /plan switched mode to plan and sent prompt argument
    await waitFor(
      () => (fakeAgent.requestsFor("session/set_mode").length > 0 ? true : undefined),
      "set_mode plan",
    );
    expect(fakeAgent.requestsFor("session/set_mode")[0].params).toMatchObject({ modeId: "plan" });
    expect(fakeAgent.requestsFor("session/prompt")[0].params).toMatchObject({
      prompt: [{ type: "text", text: "add a cache layer" }],
    });

    const userMsgs = timelineItems().filter((item) => item.type === "user_message");
    expect((userMsgs[0] as any).text).toBe("/plan add a cache layer");

    const planCard = await waitFor(() => permissions()[0], "plan card");
    await waitForTurnCompletion("s1");

    // Approve the plan
    const configsCountBefore = events.filter((e) => e.type === "session.config").length;
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: planCard.request.id,
      response: { behavior: "allow", selectedActionId: "implement" },
    });

    await waitFor(
      () => (events.filter((e) => e.type === "session.turn" && e.state === "completed")[1] ? true : undefined),
      "implementing turn",
    );

    // Restores original mode (default) rather than accept-edits because session was originally default
    const setModes = fakeAgent.requestsFor("session/set_mode");
    expect((setModes.at(-1)?.params as any).modeId).toBe("default");
    expect(events.filter((e) => e.type === "session.config").length).toBe(configsCountBefore);

    // Prompt sent with IMPLEMENT_PLAN_TEXT
    const promptReqs = fakeAgent.requestsFor("session/prompt");
    expect((promptReqs.at(-1)?.params as any).prompt[0].text).toBe(IMPLEMENT_PLAN_TEXT);

    await connection.close();
  });
});

describe("ACP Parity & Advanced Flows (Phase 3c)", () => {
  let tempDir: string;
  let fakeAgent: FakeAcpAgent;
  let events: ProviderEvent[];
  let options: AcpConnectionOptions;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-3c-test-"));
    fakeAgent = new FakeAcpAgent({ enableSteering: true });
    events = [];
    options = {
      transport: fakeAgent.clientTransport,
    };
  });

  afterEach(() => {
    fakeAgent.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
    return {
      cwd: tempDir,
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      ...overrides,
    };
  }

  function timelineItems(): ProviderTimelineItem[] {
    return events
      .filter((e): e is Extract<ProviderEvent, { type: "timeline.item" }> => e.type === "timeline.item")
      .map((e) => e.item);
  }

  function toolCallItems(): Extract<ProviderTimelineItem, { type: "tool_call" }>[] {
    return timelineItems().filter(
      (i): i is Extract<ProviderTimelineItem, { type: "tool_call" }> => i.type === "tool_call",
    );
  }

  async function waitFor<T>(predicate: () => T | undefined, label: string, timeoutMs = 3000): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = predicate();
      if (val !== undefined) return val;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function waitForTurnCompletion(
    sessionId = "s1",
    turnId?: string,
    timeoutMs = 3000,
  ): Promise<Extract<ProviderEvent, { type: "session.turn" }>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const turns = events.filter(
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" &&
          e.sessionId === sessionId &&
          (e.state === "completed" || e.state === "failed" || e.state === "canceled"),
      );
      if (turnId) {
        const match = turns.find((t) => t.turnId === turnId);
        if (match) return match;
      } else if (turns.length > 0) {
        return turns[turns.length - 1];
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for turn completion in session ${sessionId}`);
  }

  describe("Subagents", () => {
    it("discovers child from fixture parent transcript, opens child session, emits rows, and completes parent tool row", async () => {
      const parentConvo = "11111111-2222-3333-4444-555555555555";
      const childConvo = "aaaaaaaa-0000-4000-8000-000000000000";
      const childLogUri = pathToFileURL(join(tempDir, "child-transcript.jsonl")).href;

      const parentTranscript = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>\nExplore codebase\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: `Created the following subagents:\n${JSON.stringify({
            conversationId: childConvo,
            logAbsoluteUri: childLogUri,
          })}`,
          tool_calls: [
            {
              tool_name: "invoke_subagent",
              tool_args: {
                Model: "inherit",
                Prompt: "Inspect package.json",
                Role: "Codebase Researcher",
                TypeName: "research",
              },
            },
          ],
        }),
        "",
      ].join("\n");

      const childTranscript = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>\nInspect package.json\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Found 12 dependencies in package.json.",
          tool_calls: [],
        }),
        "",
      ].join("\n");

      const virtualFiles = new Map<string, string>();
      const parentPath = conversationTranscriptPath(accountGeminiRoot("default"), parentConvo);
      const childPath = join(tempDir, "child-transcript.jsonl");
      virtualFiles.set(parentPath, parentTranscript);
      virtualFiles.set(childPath, childTranscript);

      const customOptions: AcpConnectionOptions = {
        transport: fakeAgent.clientTransport,
        readTranscriptFile: async (p) => virtualFiles.get(p) ?? "",
        statTranscriptFile: async (p) => ({
          size: Buffer.byteLength(virtualFiles.get(p) ?? "", "utf8"),
          mtimeMs: Date.now(),
        }),
      };

      const connection = createAcpConnection(ACP_CAPABILITIES, customOptions);
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        persistence: {
          version: 1,
          data: {
            conversationId: parentConvo,
            accountId: "default",
            transport: "acp",
          },
        },
        history: "skip",
      });

      fakeAgent.setPromptHandler(async () => {
        fakeAgent.emitSessionUpdate("s1", {
          sessionUpdate: "tool_call",
          toolCallId: "call-sub-1",
          name: "invoke_subagent",
          args: {
            Model: "inherit",
            Prompt: "Inspect package.json",
            Role: "Codebase Researcher",
            TypeName: "research",
          },
        });

        const childId = childSessionId("s1", childConvo);
        await waitFor(
          () => events.some((e) => e.type === "session.turn" && e.sessionId === childId && e.state === "completed"),
          "child turn completed",
        );
        return { stopReason: "end_turn", usage: { totalTokens: 15 } };
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Explore codebase" }],
          },
        },
      });

      await waitForTurnCompletion("s1");

      const childId = childSessionId("s1", childConvo);
      const childOpened = events.find((e) => e.type === "session.opened" && e.sessionId === childId);
      expect(childOpened).toBeDefined();
      expect((childOpened as any).parentSessionId).toBe("s1");
      expect((childOpened as any).capabilities).toContain("session.subsession");

      const subagentRow = toolCallItems().filter((i) => i.callId === "call-sub-1").at(-1);
      expect(subagentRow).toBeDefined();
      expect(subagentRow!.detail.type).toBe("sub_agent");
      expect((subagentRow!.detail as any).childSessionId).toBe(childId);
      expect(subagentRow!.status).toBe("completed");
      expect((subagentRow!.detail as any).log).toContain("Found 12 dependencies in package.json.");

      await connection.close();
    });

    it("subagent follower survives parent turn end and stops on session close", async () => {
      const parentConvo = "11111111-2222-3333-4444-555555555555";
      const childConvo = "bbbbbbbb-0000-4000-8000-000000000000";
      const childLogUri = pathToFileURL(join(tempDir, "child-survive.jsonl")).href;

      const parentTranscript = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>\nParent work\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: `Created the following subagents:\n${JSON.stringify({
            conversationId: childConvo,
            logAbsoluteUri: childLogUri,
          })}`,
          tool_calls: [
            {
              tool_name: "invoke_subagent",
              tool_args: { Model: "inherit", Prompt: "Long background task", Role: "Worker", TypeName: "worker" },
            },
          ],
        }),
        "",
      ].join("\n");

      // Child transcript initially only has user_input, not completed yet
      let childTranscript = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>\nLong background task\n</USER_REQUEST>",
        }),
        "",
      ].join("\n");

      const virtualFiles = new Map<string, string>();
      const parentPath = conversationTranscriptPath(accountGeminiRoot("default"), parentConvo);
      const childPath = join(tempDir, "child-survive.jsonl");
      virtualFiles.set(parentPath, parentTranscript);
      virtualFiles.set(childPath, childTranscript);

      const customOptions: AcpConnectionOptions = {
        transport: fakeAgent.clientTransport,
        readTranscriptFile: async (p) => virtualFiles.get(p) ?? "",
        statTranscriptFile: async (p) => ({
          size: Buffer.byteLength(virtualFiles.get(p) ?? "", "utf8"),
          mtimeMs: Date.now(),
        }),
      };

      const connection = createAcpConnection(ACP_CAPABILITIES, customOptions);
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        persistence: {
          version: 1,
          data: {
            conversationId: parentConvo,
            accountId: "default",
            transport: "acp",
          },
        },
        history: "skip",
      });

      fakeAgent.setPromptHandler(async () => {
        fakeAgent.emitSessionUpdate("s1", {
          sessionUpdate: "tool_call",
          toolCallId: "call-sub-2",
          name: "invoke_subagent",
          args: { Model: "inherit", Prompt: "Long background task", Role: "Worker", TypeName: "worker" },
        });

        // Parent returns immediately while child is still running!
        return { stopReason: "end_turn", usage: { totalTokens: 10 } };
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Start long task" }],
          },
        },
      });

      // Parent turn completed
      await waitForTurnCompletion("s1");
      const childId = childSessionId("s1", childConvo);

      // Child session opened, but child turn is NOT completed yet
      await waitFor(() => events.some((e) => e.type === "session.opened" && e.sessionId === childId), "child open");
      expect(events.some((e) => e.type === "session.turn" && e.sessionId === childId && e.state === "completed")).toBe(
        false,
      );

      // Now complete the child transcript
      childTranscript = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>\nLong background task\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Background task completed successfully.",
          tool_calls: [],
        }),
        "",
      ].join("\n");
      virtualFiles.set(childPath, childTranscript);

      // Child follower detects update and finishes child turn
      await waitFor(
        () =>
          events.some(
            (e) => e.type === "session.turn" && e.sessionId === childId && e.state === "completed",
          )
            ? true
            : undefined,
        "child turn completed after parent ended",
      );

      const subRow = toolCallItems().filter((i) => i.callId === "call-sub-2").at(-1);
      expect(subRow?.status).toBe("completed");
      expect((subRow?.detail as any).log).toContain("Background task completed successfully.");

      // Close parent session stops followers and closes child session
      await connection.send({
        type: "session.close",
        requestId: "r-close-1",
        sessionId: "s1",
      });

      const childClosed = events.find((e) => e.type === "session.closed" && e.sessionId === childId);
      expect(childClosed).toBeDefined();

      await connection.close();
    });

    it("subagent transcript lookup respects non-default account shadow home", async () => {
      addAccount("Work");
      try {
        const parentConvo = "work-parent-uuid-1111";
        const requestedPaths: string[] = [];

        const customOptions: AcpConnectionOptions = {
          transport: fakeAgent.clientTransport,
          readTranscriptFile: async (p) => {
            requestedPaths.push(p);
            return "";
          },
          statTranscriptFile: async () => ({ size: 0, mtimeMs: Date.now() }),
        };

        const connection = createAcpConnection(ACP_CAPABILITIES, customOptions);
        connection.onEvent((e) => events.push(e));

        await connection.send({
          type: "session.open",
          requestId: "r1",
          sessionId: "s1",
          config: makeConfig(),
          persistence: {
            version: 1,
            data: {
              conversationId: parentConvo,
              accountId: "work",
              transport: "acp",
            },
          },
          history: "skip",
        });

        fakeAgent.setPromptHandler(() => {
          fakeAgent.emitSessionUpdate("s1", {
            sessionUpdate: "tool_call",
            toolCallId: "call-sub-3",
            name: "invoke_subagent",
            args: { Model: "inherit", Prompt: "Check work repo", Role: "Worker", TypeName: "worker" },
          });
          return { stopReason: "end_turn", usage: { totalTokens: 5 } };
        });

        await connection.send({
          type: "session.prompt",
          sessionId: "s1",
          prompt: {
            clientMessageId: "m1",
            delivery: "auto",
            input: {
              type: "message",
              content: [{ type: "text", text: "Check work" }],
            },
          },
        });

        await waitForTurnCompletion("s1");

        const expectedWorkRoot = accountGeminiRoot("work");
        const expectedPath = conversationTranscriptPath(expectedWorkRoot, parentConvo);
        await waitFor(() => (requestedPaths.includes(expectedPath) ? true : undefined), "requested work path");
        expect(requestedPaths).toContain(expectedPath);

        await connection.close();
      } finally {
        removeAccount("work");
      }
    });
  });

  describe("Structured Output", () => {
    it("runs one-shot agy via injectable runner, reports schema result, and relaunches fresh ACP process on next prompt", async () => {
      let currentAgent = fakeAgent;
      const dynamicTransport: AcpConnectionOptions["transport"] = {
        get input() {
          return currentAgent.clientTransport.input;
        },
        get output() {
          return currentAgent.clientTransport.output;
        },
      };

      const recordedRuns: OneShotArgs[] = [];
      const fakeRunner: OneShotRunner = async (args) => {
        recordedRuns.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({
            structured_output: { answer: "42", explanation: "Calculated" },
            response: "Answer 42",
            status: "SUCCESS",
            usage: { input_tokens: 14, output_tokens: 28 },
          }),
          stderr: "",
        };
      };

      const connection = createAcpConnection(ACP_CAPABILITIES, {
        transport: dynamicTransport,
        runOneShot: fakeRunner,
      });
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        persistence: {
          version: 1,
          data: {
            conversationId: "conv-struct-1",
            accountId: "default",
            transport: "acp",
          },
        },
        history: "skip",
      });

      // Prompt 1: Structured output
      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m-struct",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "What is the answer?" }],
          },
          outputSchema: {
            type: "object",
            properties: {
              answer: { type: "string" },
              explanation: { type: "string" },
            },
            required: ["answer"],
          },
        },
      });

      await waitForTurnCompletion("s1");

      // Verify one-shot args
      expect(recordedRuns).toHaveLength(1);
      const run = recordedRuns[0];
      expect(run.args).toContain("--conversation");
      expect(run.args).toContain("conv-struct-1");
      expect(run.args).toContain("--output-format");
      expect(run.args).toContain("json");
      expect(run.args).toContain("--json-schema");
      expect(run.args).toContain("-p");
      expect(run.args).toContain("What is the answer?");

      // Verify timeline and usage
      const assistantMsgs = timelineItems().filter((i) => i.type === "assistant_message");
      expect(
        assistantMsgs.some(
          (m: any) => m.id.startsWith("agy:schema") && m.text.includes('"answer":"42"'),
        ),
      ).toBe(true);

      const usageEvents = events.filter((e) => e.type === "session.usage");
      expect(usageEvents).toHaveLength(1);
      expect((usageEvents[0] as any).usage).toMatchObject({
        inputTokens: 14,
        outputTokens: 28,
      });

      // Prompt 2: Regular turn relaunches fresh ACP client and resumes session
      currentAgent = new FakeAcpAgent({ enableSteering: true });
      currentAgent.queuePromptResult({
        stopReason: "end_turn",
        usage: { totalTokens: 10 },
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m-normal",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Next regular message" }],
          },
        },
      });

      const p2Result = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "m-normal");
      const turn2Id = (p2Result as any)?.result?.turnId;
      await waitForTurnCompletion("s1", turn2Id);

      expect(currentAgent.requestsFor("session/resume")).toHaveLength(1);
      expect(currentAgent.requestsFor("session/resume")[0].params).toMatchObject({
        sessionId: "conv-struct-1",
      });

      await connection.close();
    });

    it("refuses prompt with outputSchema when another turn is running (busy)", async () => {
      const connection = createAcpConnection(ACP_CAPABILITIES, options);
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        persistence: {
          version: 1,
          data: {
            conversationId: "conv-busy-1",
            accountId: "default",
            transport: "acp",
          },
        },
        history: "skip",
      });

      fakeAgent.holdPrompt();

      // Start turn 1
      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Turn 1 pending" }],
          },
        },
      });

      // Try prompt 2 with outputSchema while turn 1 is active
      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m2",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Turn 2 schema" }],
          },
          outputSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
        },
      });

      const p2Result = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "m2");
      expect(p2Result).toMatchObject({
        type: "session.prompt_result",
        sessionId: "s1",
        clientMessageId: "m2",
        result: {
          type: "failed",
          error: {
            code: "busy",
          },
        },
      });

      // Cleanup held prompt
      fakeAgent.resolveHeldPrompt();
      await waitForTurnCompletion("s1");
      await connection.close();
    });

    it("refuses prompt with non-object outputSchema", async () => {
      const connection = createAcpConnection(ACP_CAPABILITIES, options);
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        persistence: {
          version: 1,
          data: {
            conversationId: "conv-schema-err",
            accountId: "default",
            transport: "acp",
          },
        },
        history: "skip",
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m-array",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Invalid schema format" }],
          },
          outputSchema: {
            type: "array",
            items: { type: "string" },
          },
        },
      });

      const res = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "m-array");
      expect(res).toMatchObject({
        type: "session.prompt_result",
        sessionId: "s1",
        clientMessageId: "m-array",
        result: {
          type: "failed",
          error: {
            code: "schema_unsupported",
          },
        },
      });

      await connection.close();
    });

    it("reports failure when one-shot runner fails", async () => {
      const failingRunner: OneShotRunner = async () => ({
        code: 1,
        stdout: "",
        stderr: "Agy fatal error: out of memory",
      });

      const connection = createAcpConnection(ACP_CAPABILITIES, {
        transport: fakeAgent.clientTransport,
        runOneShot: failingRunner,
      });
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        persistence: {
          version: 1,
          data: {
            conversationId: "conv-fail-1",
            accountId: "default",
            transport: "acp",
          },
        },
        history: "skip",
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m-fail",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Trigger failure" }],
          },
          outputSchema: {
            type: "object",
            properties: { data: { type: "string" } },
          },
        },
      });

      const turn = await waitForTurnCompletion("s1");
      expect(turn.state).toBe("failed");
      expect((turn as any).error?.message).toContain("Agy fatal error: out of memory");

      await connection.close();
    });

    it("fresh session: initializes ACP to get conversation ID then runs one-shot", async () => {
      const recordedRuns: OneShotArgs[] = [];
      const fakeRunner: OneShotRunner = async (args) => {
        recordedRuns.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({
            structured_output: { initialized: true },
            response: "Done",
            status: "SUCCESS",
          }),
          stderr: "",
        };
      };

      const connection = createAcpConnection(ACP_CAPABILITIES, {
        transport: fakeAgent.clientTransport,
        runOneShot: fakeRunner,
      });
      connection.onEvent((e) => events.push(e));

      // Fresh session (no conversationId in persistence)
      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        history: "skip",
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m-fresh-schema",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Fresh structured output" }],
          },
          outputSchema: {
            type: "object",
            properties: { initialized: { type: "boolean" } },
          },
        },
      });

      await waitForTurnCompletion("s1");

      // ACP session/new was called to allocate conversation ID
      expect(fakeAgent.requestsFor("session/new")).toHaveLength(1);

      // One-shot runner was called with the allocated conversation ID
      expect(recordedRuns).toHaveLength(1);
      expect(recordedRuns[0].args).toContain("--conversation");
      expect(recordedRuns[0].args).toContain("33bb33e6-aa54-40ed-87de-f4b4953dd305");

      await connection.close();
    });
  });

  describe("Native MCP Sharing", () => {
    it("maps stdio, http, and sse without touching .agents/mcp_config.json", async () => {
      const connection = createAcpConnection(ACP_CAPABILITIES, options);
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig({
          mcpServers: {
            localTool: {
              type: "stdio",
              command: "mcp-tool",
              args: ["serve", "--port", "0"],
              env: { TOOL_KEY: "secret" },
            },
            remoteHttp: {
              type: "http",
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer tok" },
            },
            remoteSse: {
              type: "sse",
              url: "https://example.com/sse",
              headers: { "X-Env": "prod" },
            },
          },
          settings: {
            shareMcp: "on",
          },
        }),
        history: "skip",
      });

      fakeAgent.queuePromptResult({
        stopReason: "end_turn",
        usage: { totalTokens: 10 },
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Check MCP setup" }],
          },
        },
      });

      await waitForTurnCompletion("s1");

      const newReq = fakeAgent.requestsFor("session/new")[0];
      const mcpServers = (newReq.params as any).mcpServers;
      expect(mcpServers).toHaveLength(3);

      expect(mcpServers).toContainEqual({
        name: "paseo-localTool",
        command: "mcp-tool",
        args: ["serve", "--port", "0"],
        env: [{ name: "TOOL_KEY", value: "secret" }],
      });

      expect(mcpServers).toContainEqual({
        type: "http",
        name: "paseo-remoteHttp",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      });

      expect(mcpServers).toContainEqual({
        type: "sse",
        name: "paseo-remoteSse",
        url: "https://example.com/sse",
        headers: [{ name: "X-Env", value: "prod" }],
      });

      // No ledger file .agents/mcp_config.json written
      expect(existsSync(join(tempDir, ".agents", "mcp_config.json"))).toBe(false);

      await connection.close();
    });

    it("shareMcp off passes empty mcpServers list", async () => {
      const connection = createAcpConnection(ACP_CAPABILITIES, options);
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig({
          mcpServers: {
            localTool: {
              type: "stdio",
              command: "mcp-tool",
            },
          },
          settings: {
            shareMcp: "off",
          },
        }),
        history: "skip",
      });

      fakeAgent.queuePromptResult({
        stopReason: "end_turn",
        usage: { totalTokens: 5 },
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Share MCP off" }],
          },
        },
      });

      await waitForTurnCompletion("s1");

      const newReq = fakeAgent.requestsFor("session/new")[0];
      expect((newReq.params as any).mcpServers).toEqual([]);

      await connection.close();
    });

    it("toggling shareMcp on active session lazily closes client and updates mcpServers on next prompt", async () => {
      let currentAgent = fakeAgent;
      const dynamicTransport: AcpConnectionOptions["transport"] = {
        get input() {
          return currentAgent.clientTransport.input;
        },
        get output() {
          return currentAgent.clientTransport.output;
        },
      };

      const connection = createAcpConnection(ACP_CAPABILITIES, { transport: dynamicTransport });
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig({
          mcpServers: {
            toolA: { type: "stdio", command: "tool-a" },
          },
          settings: {
            shareMcp: "on",
          },
        }),
        history: "skip",
      });

      // Turn 1 with shareMcp: on
      currentAgent.queuePromptResult({ stopReason: "end_turn", usage: { totalTokens: 5 } });
      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Turn 1" }] },
        },
      });
      await waitForTurnCompletion("s1");

      expect((currentAgent.requestsFor("session/new")[0].params as any).mcpServers).toHaveLength(1);

      // Toggle shareMcp to off
      await connection.send({
        type: "session.configure",
        requestId: "r-cfg",
        sessionId: "s1",
        changes: {
          settings: { shareMcp: "off" },
        },
      });

      const notice = events.find(
        (e) => e.type === "session.notice" && e.sessionId === "s1" && e.notice.id === "mcp-share-changed",
      );
      expect(notice).toBeDefined();

      // Turn 2 with fresh client transport
      currentAgent = new FakeAcpAgent({ enableSteering: true });
      currentAgent.queuePromptResult({ stopReason: "end_turn", usage: { totalTokens: 5 } });

      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m2",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Turn 2" }] },
        },
      });
      const p2Result = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "m2");
      const turn2Id = (p2Result as any)?.result?.turnId;
      await waitForTurnCompletion("s1", turn2Id);

      const resumeReq = currentAgent.requestsFor("session/resume")[0];
      expect(resumeReq).toBeDefined();
      expect((resumeReq.params as any).mcpServers).toEqual([]);

      await connection.close();
    });
  });

  describe("Router Logging Parity", () => {
    it("router logs every input once with transport in line for both acp and ndjson", async () => {
      const consoleSpy = vi.spyOn(console, "log");
      const router = createRouterConnection(ACP_CAPABILITIES, { acpOptions: options });
      router.onEvent((e) => events.push(e));

      // ACP session open
      await router.send({
        type: "session.open",
        requestId: "r-acp",
        sessionId: "s-acp",
        config: makeConfig({ settings: { transport: "acp" } }),
        history: "skip",
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[antigravity] input acp session.open"),
      );

      // NDJSON session open
      await router.send({
        type: "session.open",
        requestId: "r-ndjson",
        sessionId: "s-ndjson",
        config: makeConfig({ settings: { transport: "ndjson" } }),
        history: "skip",
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[antigravity] input ndjson session.open"),
      );

      consoleSpy.mockRestore();
      await router.close();
    });
  });

  describe("Steering Race", () => {
    it("starts a normal new turn if running turn completes between steer arriving and prompt being sent", async () => {
      let currentAgent = fakeAgent;
      let delayNextLaunch = false;
      const dynamicTransport: AcpConnectionOptions["transport"] = {
        get input() {
          return currentAgent.clientTransport.input;
        },
        get output() {
          return currentAgent.clientTransport.output;
        },
      };

      const connection = createAcpConnection(ACP_CAPABILITIES, { transport: dynamicTransport });
      connection.onEvent((e) => events.push(e));

      await connection.send({
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        config: makeConfig(),
        history: "skip",
      });

      // Start Turn 1 and hold it active
      fakeAgent.holdPrompt();
      await connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m1",
          delivery: "auto",
          input: {
            type: "message",
            content: [{ type: "text", text: "Turn 1 active" }],
          },
        },
      });

      // Queue result for turn 2 so it can finish once started
      fakeAgent.queuePromptResult({ stopReason: "end_turn", usage: { totalTokens: 8 } });

      // Turn 1 completes; right as it does, steer arrives before prompt is sent
      fakeAgent.resolveHeldPrompt();
      // Ensure the turn completion completes in the background
      await waitForTurnCompletion("s1");

      const steerPromise = connection.send({
        type: "session.prompt",
        sessionId: "s1",
        prompt: {
          clientMessageId: "m2",
          delivery: "steer",
          input: {
            type: "message",
            content: [{ type: "text", text: "Steering prompt racing completion" }],
          },
        },
      });

      await steerPromise;

      const m2Result = events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === "m2");
      expect(m2Result).toBeDefined();
      // Turned into a normal turn, not a steer!
      expect((m2Result as any).result.type).toBe("turn");

      await waitForTurnCompletion("s1", (m2Result as any).result.turnId);
      await connection.close();
    });
  });
});
