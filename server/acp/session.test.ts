import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ProviderCapability,
  ProviderEvent,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { FakeAcpAgent } from "../testing/fake-acp-agent";
import {
  ACP_CAPABILITIES,
} from "../provider";
import type { AcpPromptResult } from "./schema";
import { createAcpConnection, type AcpConnectionOptions } from "./session";

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

  it("structured output refusal: cleanly refuses outputSchema on ACP sessions", async () => {
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
          type: "object",
          properties: { result: { type: "string" } },
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
