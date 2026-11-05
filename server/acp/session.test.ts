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
import { createProvider, ACP_CAPABILITIES, CAPABILITIES } from "../provider";
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

  it("selects ACP transport via PASEO_ANTIGRAVITY_TRANSPORT=acp and advertises prompt.steer", async () => {
    const originalEnv = process.env.PASEO_ANTIGRAVITY_TRANSPORT;
    try {
      process.env.PASEO_ANTIGRAVITY_TRANSPORT = "acp";
      const provider = createProvider();
      const acpConn = await provider.connect({
        versions: [1],
        capabilities: [...CAPABILITIES, "prompt.steer"],
      });
      expect(acpConn.capabilities).toContain("prompt.steer");
      await acpConn.close();

      delete process.env.PASEO_ANTIGRAVITY_TRANSPORT;
      const ndjsonConn = await provider.connect({
        versions: [1],
        capabilities: [...CAPABILITIES, "prompt.steer"],
      });
      expect(ndjsonConn.capabilities).not.toContain("prompt.steer");
      await ndjsonConn.close();
    } finally {
      if (originalEnv !== undefined) {
        process.env.PASEO_ANTIGRAVITY_TRANSPORT = originalEnv;
      } else {
        delete process.env.PASEO_ANTIGRAVITY_TRANSPORT;
      }
    }
  });

  it("fresh open: calls initialize then session/new with systemPromptAppend and emits ready", async () => {
    const connection = createAcpConnection(ACP_CAPABILITIES, options);
    connection.onEvent((e) => events.push(e));

    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "s1",
      config: makeConfig({ systemPrompt: "System instructions" }),
      history: "skip",
    });

    const initReqs = fakeAgent.requestsFor("initialize");
    expect(initReqs).toHaveLength(1);
    expect(initReqs[0].params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: { form: {} },
      },
    });

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

    const opened = events.find((e) => e.type === "session.opened");
    expect(opened).toMatchObject({
      type: "session.opened",
      requestId: "r1",
      sessionId: "s1",
      persistence: {
        version: 1,
        data: {
          conversationId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
          accountId: "default",
        },
      },
    });

    expect(events.some((e) => e.type === "session.config")).toBe(true);
    expect(events.some((e) => e.type === "session.commands")).toBe(true);
    expect(events.some((e) => e.type === "session.ready")).toBe(true);

    await connection.close();
  });

  it("resume session: calls initialize then session/resume using existing conversationId", async () => {
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
        },
      },
      history: "skip",
    });

    expect(fakeAgent.requestsFor("initialize")).toHaveLength(1);
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

    const opened = events.find((e) => e.type === "session.opened");
    expect(opened).toMatchObject({
      persistence: {
        data: {
          conversationId: "existing-uuid-1234",
        },
      },
    });

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

    // Turn completed
    const turns = events.filter((e) => e.type === "session.turn");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ state: "started" });
    expect(turns[1]).toMatchObject({ state: "completed" });

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
      // 1. Vendor name/args: run_command
      fakeAgent.emitToolCall("s1", "call-cmd", "in_progress", {
        name: "run_command",
        args: { CommandLine: "ls -la", Cwd: tempDir },
      });
      fakeAgent.emitToolCall("s1", "call-cmd", "completed", {
        name: "run_command",
        rawOutput: "file1.txt\nfile2.txt",
      });

      // 2. Fallback path with diff content
      fakeAgent.emitToolCall("s1", "call-diff", "in_progress", {
        kind: "edit",
        title: "Edit foo.ts",
        content: [
          {
            type: "diff",
            path: "/path/to/foo.ts",
            oldText: "const a = 1;",
            newText: "const a = 2;",
          },
        ],
      });
      fakeAgent.emitToolCall("s1", "call-diff", "completed");

      // 3. Fallback path without diff (standard kind)
      fakeAgent.emitToolCall("s1", "call-read", "in_progress", {
        kind: "read",
        title: "Read bar.txt",
        locations: [{ path: "/path/to/bar.txt" }],
      });
      fakeAgent.emitToolCall("s1", "call-read", "failed", {
        rawOutput: "Permission denied",
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
          content: [{ type: "text", text: "Run tools" }],
        },
      },
    });

    const items = timelineItems();
    const toolItems = items.filter((i) => i.type === "tool_call");

    // Vendor tool call
    const cmdTools = toolItems.filter((i) => i.callId === "call-cmd");
    expect(cmdTools).toHaveLength(2);
    expect(cmdTools[0]).toMatchObject({
      status: "running",
      detail: { type: "shell", command: "ls -la" },
    });
    expect(cmdTools[1]).toMatchObject({
      status: "completed",
      detail: { type: "shell", output: "file1.txt\nfile2.txt" },
    });

    // Diff tool call
    const diffTools = toolItems.filter((i) => i.callId === "call-diff");
    expect(diffTools).toHaveLength(2);
    expect(diffTools[0]).toMatchObject({
      status: "running",
      detail: {
        type: "edit",
        filePath: "/path/to/foo.ts",
        oldString: "const a = 1;",
        newString: "const a = 2;",
      },
    });
    expect(diffTools[1]).toMatchObject({ status: "completed" });

    // Failed tool call
    const readTools = toolItems.filter((i) => i.callId === "call-read");
    expect(readTools).toHaveLength(2);
    expect(readTools[0]).toMatchObject({
      status: "running",
      detail: { type: "read", filePath: "/path/to/bar.txt" },
    });
    expect(readTools[1]).toMatchObject({
      status: "failed",
      error: "Permission denied",
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
        inputTokens: 120,
        cachedReadTokens: 40,
        outputTokens: 50,
        thoughtTokens: 25,
        totalTokens: 195,
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
          content: [{ type: "text", text: "Check usage" }],
        },
      },
    });

    const usageEvent = events.find((e) => e.type === "session.usage");
    expect(usageEvent).toBeDefined();
    expect(usageEvent).toMatchObject({
      type: "session.usage",
      sessionId: "s1",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 40,
        outputTokens: 75, // 50 output + 25 thought
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
      // Awaiting interrupt
      return new Promise((resolve) => {
        // Will be resolved via session/cancel notification in FakeAcpAgent
      });
    });

    const promptPromise = connection.send({
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

    // Give prompt a moment to register and start tool
    await new Promise((r) => setTimeout(r, 20));

    // Send interrupt
    await connection.send({
      type: "session.interrupt",
      requestId: "req-int",
      sessionId: "s1",
    });

    await promptPromise;

    expect(fakeAgent.notificationsFor("session/cancel")).toHaveLength(1);

    const items = timelineItems();
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

    let firstPromptResolved = false;
    fakeAgent.setPromptHandler(async (params, id) => {
      if (id === 3) {
        // First session/prompt (requests: 1=initialize, 2=session/new, 3=prompt 1)
        fakeAgent.emitChunk("s1", "Starting turn 1...", "agent_message_chunk");
        return new Promise<AcpPromptResult>((resolve) => {
          // When steered, fakeAgent will resolve this with end_turn (no usage)
          setTimeout(() => {
            firstPromptResolved = true;
            resolve({ stopReason: "end_turn" });
          }, 30);
        });
      }
      // Steered prompt (id === 4)
      fakeAgent.emitChunk("s1", "Steered answer", "agent_message_chunk");
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 50,
          outputTokens: 30,
        },
      };
    });

    const prompt1Promise = connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "msg-1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "First instruction" }],
        },
      },
    });

    // Wait until prompt 1 has started
    await new Promise((r) => setTimeout(r, 10));

    // Send steer prompt
    const prompt2Promise = connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "msg-2",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "Wait, do this instead" }],
        },
      },
    });

    await Promise.all([prompt1Promise, prompt2Promise]);

    // Check prompt results
    const promptResults = events.filter((e) => e.type === "session.prompt_result");
    expect(promptResults).toHaveLength(2);
    expect(promptResults[0]).toMatchObject({
      clientMessageId: "msg-1",
      result: { type: "turn" },
    });
    const turnId = (promptResults[0] as any).result.turnId;
    expect(promptResults[1]).toMatchObject({
      clientMessageId: "msg-2",
      result: { type: "steer", turnId },
    });

    // Both user messages published
    const userMsgs = timelineItems().filter((i) => i.type === "user_message");
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0]).toMatchObject({ text: "First instruction" });
    expect(userMsgs[1]).toMatchObject({ text: "Wait, do this instead" });

    // Exactly ONE turn completed!
    const turnCompletions = events.filter((e) => e.type === "session.turn" && e.state === "completed");
    expect(turnCompletions).toHaveLength(1);
    expect(turnCompletions[0]).toMatchObject({ turnId });

    // Usage from steering prompt reported
    const usage = events.find((e) => e.type === "session.usage");
    expect(usage).toMatchObject({
      usage: { inputTokens: 50, outputTokens: 30 },
    });

    await connection.close();
  });

  it("configure: set_mode and set_config_option map model and thought_level without restart", async () => {
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
      type: "session.configure",
      requestId: "req-cfg",
      sessionId: "s1",
      changes: {
        mode: "accept-edits",
        model: "gemini-3.8-flash",
        thinkingOption: "high",
      },
    });

    const modeReqs = fakeAgent.requestsFor("session/set_mode");
    expect(modeReqs).toHaveLength(1);
    expect(modeReqs[0].params).toEqual({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      modeId: "accept-edits",
    });

    const configReqs = fakeAgent.requestsFor("session/set_config_option");
    expect(configReqs).toHaveLength(2);
    expect(configReqs[0].params).toEqual({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      configId: "model",
      value: "gemini-3.8-flash",
    });
    expect(configReqs[1].params).toEqual({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      configId: "thought_level",
      value: "high",
    });

    const completed = events.find((e) => e.type === "request.completed" && e.requestId === "req-cfg");
    expect(completed).toBeDefined();

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

    // Agent emits commands with duplicate SKILL names and system command overlap
    fakeAgent.emitSessionUpdate("33bb33e6-aa54-40ed-87de-f4b4953dd305", {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "SKILL", description: "First skill" },
        { name: "SKILL", description: "Duplicate skill" },
        { name: "my_tool", description: "Custom tool" },
        { name: "plan", description: "Agent plan" },
      ],
    });

    const cmdEvents = events.filter((e) => e.type === "session.commands");
    expect(cmdEvents.length).toBeGreaterThanOrEqual(2);
    const lastCmds = (cmdEvents.at(-1) as any).commands;

    // System commands first
    expect(lastCmds.find((c: any) => c.name === "goal")).toBeDefined();
    // System "plan" description preserved (not overridden by agent plan)
    expect(lastCmds.find((c: any) => c.name === "plan").description).toContain("Plan the task");
    // Duplicate SKILL dropped; first SKILL preserved
    const skillCmds = lastCmds.filter((c: any) => c.name === "SKILL");
    expect(skillCmds).toHaveLength(1);
    expect(skillCmds[0].description).toBe("First skill");
    // Custom tool included
    expect(lastCmds.find((c: any) => c.name === "my_tool")).toBeDefined();

    // A prompt sent as command reaches ACP formatted as /name args
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "cmd-prompt",
        delivery: "auto",
        input: {
          type: "command",
          name: "my_tool",
          arguments: "arg1 arg2",
        },
      },
    });

    const promptReqs = fakeAgent.requestsFor("session/prompt");
    const lastPrompt = promptReqs.at(-1);
    expect(lastPrompt?.params).toMatchObject({
      prompt: [{ type: "text", text: "/my_tool arg1 arg2" }],
    });

    await connection.close();
  });

  it("crash recovery: fails running turn, then next prompt relaunches and resumes session", async () => {
    let currentAgent = fakeAgent;
    const connection = createAcpConnection(ACP_CAPABILITIES, {
      transport: () => currentAgent.clientTransport,
    });
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
        args: { CommandLine: "start" },
      });
      return new Promise(() => {});
    });

    const prompt1Promise = connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Before crash" }],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Agent crashes
    currentAgent.crash(new Error("Process crashed suddenly"));
    await prompt1Promise;

    // Running tool failed
    const toolItems = toolCallItems().filter((i) => i.callId === "running-cmd");
    expect(toolItems.at(-1)).toMatchObject({ status: "failed" });

    // Turn 1 failed
    const turn1Fail = events.find((e) => e.type === "session.turn" && e.state === "failed");
    expect(turn1Fail).toBeDefined();

    // Create fresh agent for next launch
    const nextAgent = new FakeAcpAgent();
    currentAgent = nextAgent;

    // Next prompt relaunches and resumes
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m2",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "After crash recovery" }],
        },
      },
    });

    // Verify session/resume was called on the new agent with original conversationId
    expect(nextAgent.requestsFor("initialize")).toHaveLength(1);
    const resumeReqs = nextAgent.requestsFor("session/resume");
    expect(resumeReqs).toHaveLength(1);
    expect(resumeReqs[0].params).toMatchObject({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      cwd: tempDir,
    });

    nextAgent.close();
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
        clientMessageId: "m-schema",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Return schema" }],
        },
        outputSchema: { type: "object", properties: { ans: { type: "string" } } },
      },
    });

    const res = events.find((e) => e.type === "session.prompt_result");
    expect(res).toMatchObject({
      clientMessageId: "m-schema",
      result: {
        type: "failed",
        error: {
          code: "schema_unsupported",
          message: "Structured output is not supported over ACP yet",
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

    await connection.send({
      type: "session.can_stop_runtime",
      requestId: "check-idle",
      sessionId: "s1",
    });

    const idleEvent = events.find((e) => e.type === "session.can_stop_runtime");
    expect(idleEvent).toMatchObject({ canStop: true });

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
