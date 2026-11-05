import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAcpAgent } from "../testing/fake-acp-agent";
import { AgyAcpClient } from "./client";
import {
  acpInitializeResultSchema,
  acpNewSessionResultSchema,
  acpPromptResultSchema,
  acpToolCallUpdateSchema,
  type AcpSessionUpdateNotification,
} from "./schema";

describe("AgyAcpClient", () => {
  it("completes the initialize handshake with protocol capabilities", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    const initResult = await client.initialize();

    expect(initResult.protocolVersion).toBe(1);
    expect(initResult.agentCapabilities).toBeDefined();
    expect(initResult.authMethods).toHaveLength(4);

    const initRequests = fakeAgent.requestsFor("initialize");
    expect(initRequests).toHaveLength(1);
    expect(initRequests[0].params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });

    await client.close();
    fakeAgent.close();
  });

  it("creates a new session with cwd, mcpServers, and systemPromptAppend", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    const sessionResult = await client.newSession({
      cwd: "/fake/workspace",
      mcpServers: [{ name: "test-mcp" }],
      systemPromptAppend: "Instructions for this turn",
    });

    expect(sessionResult.sessionId).toBe("33bb33e6-aa54-40ed-87de-f4b4953dd305");
    expect(sessionResult.models?.currentModelId).toBe("gemini-3.8-flash-high");
    expect(sessionResult.models?.availableModels?.[0].modelId).toBe("gemini-3.8-flash-high");
    expect(sessionResult.modes?.currentModeId).toBe("default");
    expect(client.sessionId).toBe("33bb33e6-aa54-40ed-87de-f4b4953dd305");

    const newRequests = fakeAgent.requestsFor("session/new");
    expect(newRequests).toHaveLength(1);
    expect(newRequests[0].params).toEqual({
      cwd: "/fake/workspace",
      mcpServers: [{ name: "test-mcp" }],
      _meta: {
        antigravity: {
          systemPrompt: {
            append: "Instructions for this turn",
          },
        },
      },
    });

    await client.close();
    fakeAgent.close();
  });

  it("resumes an existing session by conversation ID", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.resumeSession({
      sessionId: "existing-conversation-uuid",
      cwd: "/fake/workspace",
      systemPromptAppend: "Resumed prompt",
    });

    expect(client.sessionId).toBe("existing-conversation-uuid");

    const resumeRequests = fakeAgent.requestsFor("session/resume");
    expect(resumeRequests).toHaveLength(1);
    expect(resumeRequests[0].params).toEqual({
      sessionId: "existing-conversation-uuid",
      cwd: "/fake/workspace",
      mcpServers: [],
      _meta: {
        antigravity: {
          systemPrompt: {
            append: "Resumed prompt",
          },
        },
      },
    });

    await client.close();
    fakeAgent.close();
  });

  it("streams updates during a prompt and resolves with stopReason and usage", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    const receivedUpdates: unknown[] = [];
    client.on("sessionUpdate", (notif: AcpSessionUpdateNotification) => {
      receivedUpdates.push(notif.update);
    });

    fakeAgent.setPromptHandler(async ({ sessionId, prompt }) => {
      expect(prompt).toEqual([{ type: "text", text: "Hello ACP" }]);

      fakeAgent.emitChunk(sessionId, "Thinking...", "agent_thought_chunk");
      fakeAgent.emitChunk(sessionId, "Hello! How can I help?", "agent_message_chunk");
      fakeAgent.emitToolCall(sessionId, "tool-1", "completed", {
        kind: "execute",
        title: "Run Command",
        name: "run_command",
      });

      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 15,
          outputTokens: 30,
          thoughtTokens: 10,
          totalTokens: 55,
        },
      };
    });

    const result = await client.prompt([{ type: "text", text: "Hello ACP" }]);

    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.totalTokens).toBe(55);
    expect(receivedUpdates).toHaveLength(3);
    expect(receivedUpdates[0]).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
      content: { text: "Thinking..." },
    });
    expect(receivedUpdates[1]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { text: "Hello! How can I help?" },
    });
    expect(receivedUpdates[2]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      name: "run_command",
    });

    await client.close();
    fakeAgent.close();
  });

  it("supports mid-turn steering where the second prompt causes both promises to resolve independently", async () => {
    const fakeAgent = new FakeAcpAgent({ enableSteering: true });
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    // Send first long-running prompt
    const prompt1Promise = client.prompt([{ type: "text", text: "count slowly to 100" }]);

    // Wait slightly so the agent receives prompt 1
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Send steering prompt while prompt 1 is active
    const prompt2Promise = client.prompt([{ type: "text", text: "stop, say hello instead" }]);

    const [res1, res2] = await Promise.all([prompt1Promise, prompt2Promise]);

    // First prompt is superseded and resolved with end_turn (no usage)
    expect(res1.stopReason).toBe("end_turn");
    expect(res1.usage).toBeUndefined();

    // Second prompt completes the turn with full usage
    expect(res2.stopReason).toBe("end_turn");
    expect(res2.usage?.totalTokens).toBe(35);

    await client.close();
    fakeAgent.close();
  });

  it("cancels a running prompt via session/cancel and resolves with stopReason 'cancelled'", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    // Hold the prompt in-flight so it can be cancelled
    fakeAgent.holdPrompt();
    const promptPromise = client.prompt([{ type: "text", text: "long task" }]);

    // Wait for prompt to reach agent
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Client cancels the turn
    client.cancel();

    // The fake agent receives session/cancel and resolves prompt with stopReason: "cancelled"
    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");

    const cancelNotifications = fakeAgent.notificationsFor("session/cancel");
    expect(cancelNotifications).toHaveLength(1);
    expect(cancelNotifications[0].params).toEqual({ sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305" });

    await client.close();
    fakeAgent.close();
  });

  it("supports setting modes and config options", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    await client.setMode("plan");
    await client.setConfigOption("thought_level", "low");

    const modeRequests = fakeAgent.requestsFor("session/set_mode");
    expect(modeRequests).toHaveLength(1);
    expect(modeRequests[0].params).toEqual({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      modeId: "plan",
    });

    const configRequests = fakeAgent.requestsFor("session/set_config_option");
    expect(configRequests).toHaveLength(1);
    expect(configRequests[0].params).toEqual({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      configId: "thought_level",
      value: "low",
    });

    await client.close();
    fakeAgent.close();
  });

  it("closes the active session and refuses prompts until a new one is opened", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });
    expect(client.sessionId).toBe("33bb33e6-aa54-40ed-87de-f4b4953dd305");

    await client.closeSession();
    expect(client.sessionId).toBeNull();

    const closeRequests = fakeAgent.requestsFor("session/close");
    expect(closeRequests).toHaveLength(1);
    expect(closeRequests[0].params).toEqual({ sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305" });

    await expect(client.prompt([{ type: "text", text: "after close" }])).rejects.toThrow(
      "No active ACP session",
    );

    await client.close();
    fakeAgent.close();
  });

  it("handles incoming session/request_permission round-trip", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    client.setRequestPermissionHandler(async (params) => {
      expect(params.sessionId).toBe("33bb33e6-aa54-40ed-87de-f4b4953dd305");
      expect(params.options).toHaveLength(2);
      expect(params.options?.[0].optionId).toBe("opt-allow");
      return { outcome: { outcome: "selected", optionId: "opt-allow" } };
    });

    await client.newSession({ cwd: "/fake/workspace" });

    // Agent initiates permission request to client
    const outcome = await fakeAgent.requestPermission({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      toolCall: { name: "run_command", args: { cmd: "npm test" } },
      options: [
        { optionId: "opt-allow", name: "Allow this time", kind: "allow_once" },
        { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
      ],
    });

    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "opt-allow" },
    });

    await client.close();
    fakeAgent.close();
  });

  it("returns cancelled outcome for permission request when no handler is registered", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    const outcome = await fakeAgent.requestPermission({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      options: [{ optionId: "opt-1", name: "Option 1", kind: "allow_once" }],
    });

    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });

    await client.close();
    fakeAgent.close();
  });

  it("handles incoming elicitation/create (ask_question) round-trip", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    client.setElicitationHandler(async (params) => {
      expect(params.sessionId).toBe("33bb33e6-aa54-40ed-87de-f4b4953dd305");
      expect(params.mode).toBe("form");
      expect(params.message).toBe("Which database should we use?");
      return { action: "accept", content: { q1: "postgres" } };
    });

    await client.newSession({ cwd: "/fake/workspace" });

    const response = await fakeAgent.createElicitation({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      toolCallId: "tool-ask-1",
      mode: "form",
      message: "Which database should we use?",
      requestedSchema: {
        type: "object",
        properties: {
          q1: {
            type: "string",
            title: "Database",
            oneOf: [
              { const: "postgres", title: "PostgreSQL" },
              { const: "sqlite", title: "SQLite" },
            ],
          },
        },
      },
    });

    expect(response).toEqual({
      action: "accept",
      content: { q1: "postgres" },
    });

    await client.close();
    fakeAgent.close();
  });

  it("rejects pending calls when the agent process or transport crashes", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    fakeAgent.holdPrompt();
    const pendingPrompt = client.prompt([{ type: "text", text: "will crash" }]);

    // Wait slightly so request is dispatched
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate agent process crash
    fakeAgent.crash(new Error("Process abruptly terminated"));

    await expect(pendingPrompt).rejects.toThrow("Process abruptly terminated");

    await client.close();
  });

  it("tolerates malformed lines on the stream without dropping subsequent messages", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    // Send noisy / malformed lines before sending the prompt response
    fakeAgent.sendRaw("--- noisy CLI startup header ---");
    fakeAgent.sendRaw("{broken json");
    fakeAgent.sendRaw("");

    const result = await client.prompt([{ type: "text", text: "after noise" }]);
    expect(result.stopReason).toBe("end_turn");

    await client.close();
    fakeAgent.close();
  });

  it("invokes permission and elicitation handlers passed in constructor options", async () => {
    let permissionInvoked = false;
    let elicitationInvoked = false;

    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      {
        transport: fakeAgent.clientTransport,
        onRequestPermission: async () => {
          permissionInvoked = true;
          return { outcome: { outcome: "selected", optionId: "opt-1" } };
        },
        onElicitation: async () => {
          elicitationInvoked = true;
          return { action: "accept", content: { ok: true } };
        },
      },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    await fakeAgent.requestPermission({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      options: [{ optionId: "opt-1", name: "Allow", kind: "allow_once" }],
    });
    expect(permissionInvoked).toBe(true);

    await fakeAgent.createElicitation({
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      mode: "form",
    });
    expect(elicitationInvoked).toBe(true);

    await client.close();
    fakeAgent.close();
  });

  it("handles process launch failure when binary is non-existent", async () => {
    const client = new AgyAcpClient({
      cwd: "/fake/workspace",
      binary: "/path/to/non_existent_binary_xyz_123",
    });

    let crashEventFired = false;
    client.on("crash", () => {
      crashEventFired = true;
    });

    await expect(client.initialize()).rejects.toThrow();
    expect(crashEventFired).toBe(true);
    expect(client.stderrTail.length).toBeGreaterThan(0);
    expect(client.stderrTail[0]).toContain("failed to launch");

    await client.close();
  });

  it("captures stderr tail and rejects when process exits with non-zero exit code", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-exit-test-"));
    const scriptPath = join(tempDir, "fake-exit.sh");
    writeFileSync(scriptPath, "#!/bin/sh\necho 'Fatal agy panic' >&2\nexit 42\n", {
      mode: 0o755,
    });

    const client = new AgyAcpClient({
      cwd: tempDir,
      binary: scriptPath,
    });

    let exitInfo: { code: number | null } | null = null;
    client.on("exit", (info) => {
      exitInfo = info;
    });

    await expect(client.initialize()).rejects.toThrow(/code 42[\s\S]*Fatal agy panic/);
    expect(exitInfo).toEqual({ code: 42, signal: null });
    expect(client.stderrTail).toContain("Fatal agy panic");

    await client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("bounds closeSession wait during close() when agy hangs on session/close", async () => {
    const fakeAgent = new FakeAcpAgent();
    // Simulate hung session/close
    fakeAgent.connection.onRequest("session/close", () => new Promise(() => {}));

    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      {
        transport: fakeAgent.clientTransport,
        closeSessionTimeoutMs: 50,
      },
    );

    await client.newSession({ cwd: "/fake/workspace" });

    const start = Date.now();
    await client.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(client.running).toBe(false);

    fakeAgent.close();
  });

  it("emits the 'close' event exactly once during teardown", async () => {
    const fakeAgent = new FakeAcpAgent();
    const client = new AgyAcpClient(
      { cwd: "/fake/workspace" },
      { transport: fakeAgent.clientTransport },
    );

    let closeCount = 0;
    client.on("close", () => {
      closeCount++;
    });

    await client.newSession({ cwd: "/fake/workspace" });

    // Explicit close() plus transport close
    await client.close();
    fakeAgent.close();

    // Calling close again should also be a no-op
    await client.close();

    expect(closeCount).toBe(1);
  });

  it("terminates spawned process gracefully by closing stdin before escalating", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-graceful-test-"));
    const scriptPath = join(tempDir, "graceful.sh");
    // Script reads stdin until EOF, logs graceful exit to stderr, and exits 0
    writeFileSync(
      scriptPath,
      "#!/bin/sh\nwhile read line; do :; done\necho 'flushed and exited gracefully' >&2\nexit 0\n",
      { mode: 0o755 },
    );

    const client = new AgyAcpClient(
      {
        cwd: tempDir,
        binary: scriptPath,
      },
      {
        exitGraceStepMs: 500,
      },
    );

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await client.close();

    expect(client.stderrTail).toContain("flushed and exited gracefully");
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("escalates to SIGTERM when spawned process ignores stdin closure", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-term-test-"));
    const scriptPath = join(tempDir, "term.sh");
    // Script ignores stdin closure and loops
    writeFileSync(
      scriptPath,
      "#!/bin/sh\nwhile true; do sleep 1; done\n",
      { mode: 0o755 },
    );

    const client = new AgyAcpClient(
      {
        cwd: tempDir,
        binary: scriptPath,
      },
      {
        exitGraceStepMs: 50,
      },
    );

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    client.on("exit", (info) => {
      exitInfo = info;
    });

    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await client.close();

    // The process did not exit on stdin closure, so SIGTERM was sent
    expect(exitInfo).toEqual({ code: null, signal: "SIGTERM" });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses real agy 1.5.0 session/new, initialize, tool_call_update, and prompt results", () => {
    // 1. Exact captured session/new payload from agy 1.5.0
    const rawNewSession = JSON.parse(
      '{"sessionId":"33bb33e6-aa54-40ed-87de-f4b4953dd305","models":{"availableModels":[{"modelId":"gemini-3.8-flash-high","name":"Gemini 3.8 Flash (High)"},{"modelId":"gemini-3.8-flash-medium","name":"Gemini 3.8 Flash (Medium)"},{"modelId":"gemini-3.8-flash-low","name":"Gemini 3.8 Flash (Low)"}],"currentModelId":"gemini-3.8-flash-high"},"modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Default","description":"Ask before edits and commands, per your permission settings."},{"id":"accept-edits","name":"Accept edits","description":"Approve file edits in the workspace without asking."},{"id":"plan","name":"Plan","description":"Plan carefully before executing a task."}]},"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"gemini-3.8-flash","options":[{"value":"gemini-3.8-flash","name":"Gemini 3.8 Flash"}]},{"id":"thought_level","name":"Thinking Level","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]},{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"default","options":[{"value":"default","name":"Default","description":"Ask before edits and commands, per your permission settings."},{"value":"accept-edits","name":"Accept edits","description":"Approve file edits in the workspace without asking."},{"value":"plan","name":"Plan","description":"Plan carefully before executing a task."}]}],"_meta":{"antigravity":{"tier":{"name":"Google AI Pro","id":"g1-pro-tier","upgradeUri":"https://antigravity.google/g1-upgrade"}}}}',
    );
    const parsedNew = acpNewSessionResultSchema.parse(rawNewSession);
    expect(parsedNew.sessionId).toBe("33bb33e6-aa54-40ed-87de-f4b4953dd305");
    expect(parsedNew.models?.availableModels).toHaveLength(3);
    expect(parsedNew.models?.availableModels?.[0].modelId).toBe("gemini-3.8-flash-high");
    expect(parsedNew.models?.currentModelId).toBe("gemini-3.8-flash-high");

    // 2. Exact captured initialize payload from agy 1.5.0
    const rawInit = JSON.parse(
      '{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"load_session":true,"promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},"sessionCapabilities":{"resume":{},"close":{},"load":{},"list":{},"additionalDirectories":{}},"session_capabilities":{"resume":{},"close":{},"load":{},"list":{},"additionalDirectories":{}},"auth":{"logout":{}},"_meta":{"antigravity":{"tier":true,"systemPrompt":{"append":true}}}},"agentInfo":{"name":"Antigravity ACP Server","version":"1.5.0"},"authMethods":[{"id":"oauth-personal","name":"Log in with Google","description":"Log in with your Google account"},{"id":"oauth-business","name":"Log in with Gemini Enterprise","description":"Log in with your Gemini Enterprise account"},{"id":"gemini-api-key","name":"Gemini API key","description":"Use an API key with Gemini Developer API"},{"id":"agent-platform","name":"Gemini Enterprise Agent Platform","description":"Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials"}]}',
    );
    const parsedInit = acpInitializeResultSchema.parse(rawInit);
    expect(parsedInit.protocolVersion).toBe(1);
    expect(parsedInit.agentInfo?.name).toBe("Antigravity ACP Server");
    expect(parsedInit.authMethods).toHaveLength(4);

    // 3. Exact captured tool_call_update payload from agy 1.5.0
    const rawTool = JSON.parse(
      '{"sessionUpdate":"tool_call_update","toolCallId":"call_173764","name":"write_file","args":{"Content":"hi\\n","Path":"/tmp/x/hello.txt"},"status":"completed","kind":"edit","title":"File hello.txt","locations":[{"path":"/tmp/x/hello.txt"}],"rawInput":{"Content":"hi\\n","Path":"/tmp/x/hello.txt"},"rawOutput":{},"content":[{"type":"diff","path":"/tmp/x/hello.txt","newText":"hi\\n"}]}',
    );
    const parsedTool = acpToolCallUpdateSchema.parse(rawTool);
    expect(parsedTool.toolCallId).toBe("call_173764");
    expect(parsedTool.name).toBe("write_file");
    expect(parsedTool.status).toBe("completed");

    // Also test tool_call_update when rawOutput and content are absent
    const rawToolMinimal = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_999",
      name: "run_command",
    };
    const parsedMinimal = acpToolCallUpdateSchema.parse(rawToolMinimal);
    expect(parsedMinimal.toolCallId).toBe("call_999");
    expect(parsedMinimal.name).toBe("run_command");

    // 4. Exact captured session/prompt results from agy 1.5.0
    const rawPromptWithUsage = JSON.parse(
      '{"stopReason":"end_turn","usage":{"inputTokens":29549,"outputTokens":395,"cachedReadTokens":0,"cachedWriteTokens":0,"thoughtTokens":335,"totalTokens":29944}}',
    );
    const parsedPrompt1 = acpPromptResultSchema.parse(rawPromptWithUsage);
    expect(parsedPrompt1.stopReason).toBe("end_turn");
    expect(parsedPrompt1.usage?.totalTokens).toBe(29944);

    const rawPromptSteered = JSON.parse('{"stopReason":"end_turn"}');
    const parsedPrompt2 = acpPromptResultSchema.parse(rawPromptSteered);
    expect(parsedPrompt2.stopReason).toBe("end_turn");
    expect(parsedPrompt2.usage).toBeUndefined();
  });
});
