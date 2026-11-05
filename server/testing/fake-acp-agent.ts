import { PassThrough } from "node:stream";
import { JsonRpcConnection } from "../acp/rpc";
import type {
  AcpElicitationParams,
  AcpElicitationResult,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpPromptContent,
  AcpPromptResult,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpResumeSessionResult,
  AcpSessionUpdate,
  AcpToolCallUpdate,
} from "../acp/schema";

export interface RecordedRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export interface RecordedNotification {
  method: string;
  params: unknown;
}

export interface FakeAcpAgentOptions {
  initializeResult?: Partial<AcpInitializeResult>;
  newSessionResult?: Partial<AcpNewSessionResult>;
  resumeSessionResult?: Partial<AcpResumeSessionResult>;
  enableSteering?: boolean;
}

/**
 * Scripted fake ACP agent running entirely in-process using Node.js PassThrough streams.
 *
 * Implements the agent side of ACP (`agy acp`):
 * - Records all incoming requests and notifications for test assertions.
 * - Answers `initialize`, `session/new`, `session/resume`, `session/prompt`, `session/set_mode`,
 *   `session/set_config_option`, and `session/close`.
 * - Emits streamed `session/update` notifications (messages, thoughts, tool calls, commands, modes).
 * - Sends incoming agent requests to the client:
 *   - `session/request_permission`
 *   - `elicitation/create` (form-based ask_question)
 * - Faithfully simulates mid-turn steering (prompt 2 immediately resolves pending prompt 1 with `end_turn`).
 * - Simulates malformed line injection and abrupt process crashes for error recovery testing.
 */
export class FakeAcpAgent {
  readonly toClient = new PassThrough();
  readonly fromClient = new PassThrough();
  readonly clientTransport: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
  readonly connection: JsonRpcConnection;

  readonly recordedRequests: RecordedRequest[] = [];
  readonly recordedNotifications: RecordedNotification[] = [];

  private promptQueue: AcpPromptResult[] = [];
  private promptHandler?: (
    params: { sessionId: string; prompt: AcpPromptContent[] },
    id: number | string,
  ) => Promise<AcpPromptResult> | AcpPromptResult;

  private steeringEnabled: boolean;
  private shouldHoldPrompt = false;
  private activePrompt: {
    id: number | string;
    resolve: (result: AcpPromptResult) => void;
    reject: (error: Error) => void;
  } | null = null;

  private initResult: AcpInitializeResult;
  private newSessionResult: AcpNewSessionResult;
  private resumeSessionResult: AcpResumeSessionResult;

  constructor(options: FakeAcpAgentOptions = {}) {
    this.clientTransport = {
      input: this.toClient,
      output: this.fromClient,
    };
    // Silence unhandled stream errors on destruction
    this.toClient.on("error", () => {});
    this.fromClient.on("error", () => {});
    this.connection = new JsonRpcConnection(this.fromClient, this.toClient);
    this.steeringEnabled = options.enableSteering ?? false;

    this.initResult = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        load_session: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: {
          resume: {},
          close: {},
          load: {},
          list: {},
          additionalDirectories: {},
        },
        session_capabilities: {
          resume: {},
          close: {},
          load: {},
          list: {},
          additionalDirectories: {},
        },
        auth: { logout: {} },
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
      },
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.0" },
      authMethods: [
        {
          id: "oauth-personal",
          name: "Log in with Google",
          description: "Log in with your Google account",
        },
        {
          id: "oauth-business",
          name: "Log in with Gemini Enterprise",
          description: "Log in with your Gemini Enterprise account",
        },
        {
          id: "gemini-api-key",
          name: "Gemini API key",
          description: "Use an API key with Gemini Developer API",
        },
        {
          id: "agent-platform",
          name: "Gemini Enterprise Agent Platform",
          description:
            "Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials",
        },
      ],
      ...options.initializeResult,
    };

    this.newSessionResult = {
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      models: {
        availableModels: [
          { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
          { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
        ],
        currentModelId: "gemini-3.8-flash-high",
      },
      modes: {
        currentModeId: "default",
        availableModes: [
          {
            id: "default",
            name: "Default",
            description: "Ask before edits and commands, per your permission settings.",
          },
          {
            id: "accept-edits",
            name: "Accept edits",
            description: "Approve file edits in the workspace without asking.",
          },
          {
            id: "plan",
            name: "Plan",
            description: "Plan carefully before executing a task.",
          },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-3.8-flash",
          options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
        },
        {
          id: "thought_level",
          name: "Thinking Level",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [
            {
              value: "default",
              name: "Default",
              description: "Ask before edits and commands, per your permission settings.",
            },
            {
              value: "accept-edits",
              name: "Accept edits",
              description: "Approve file edits in the workspace without asking.",
            },
            {
              value: "plan",
              name: "Plan",
              description: "Plan carefully before executing a task.",
            },
          ],
        },
      ],
      _meta: {
        antigravity: {
          tier: {
            name: "Google AI Pro",
            id: "g1-pro-tier",
            upgradeUri: "https://antigravity.google/g1-upgrade",
          },
        },
      },
      ...options.newSessionResult,
    };

    this.resumeSessionResult = {
      sessionId: "33bb33e6-aa54-40ed-87de-f4b4953dd305",
      ...options.resumeSessionResult,
    };

    this.setupHandlers();
  }

  enableSteering(enabled = true): void {
    this.steeringEnabled = enabled;
  }

  /**
   * Keep the next prompt pending until explicitly resolved, cancelled, or steered.
   */
  holdPrompt(): void {
    this.shouldHoldPrompt = true;
  }

  resolveHeldPrompt(result?: Partial<AcpPromptResult>): void {
    if (this.activePrompt) {
      const active = this.activePrompt;
      this.activePrompt = null;
      active.resolve({
        stopReason: "end_turn",
        usage: { totalTokens: 10 },
        ...result,
      });
    }
  }

  setPromptHandler(
    handler: (
      params: { sessionId: string; prompt: AcpPromptContent[] },
      id: number | string,
    ) => Promise<AcpPromptResult> | AcpPromptResult,
  ): void {
    this.promptHandler = handler;
  }

  queuePromptResult(result: AcpPromptResult): void {
    this.promptQueue.push(result);
  }

  /**
   * Find recorded requests by method name.
   */
  requestsFor(method: string): readonly RecordedRequest[] {
    return this.recordedRequests.filter((r) => r.method === method);
  }

  /**
   * Find recorded notifications by method name.
   */
  notificationsFor(method: string): readonly RecordedNotification[] {
    return this.recordedNotifications.filter((n) => n.method === method);
  }

  /**
   * Emit a `session/update` notification to the client.
   */
  emitSessionUpdate(sessionId: string, update: AcpSessionUpdate): void {
    this.connection.notify("session/update", {
      sessionId,
      update,
    });
  }

  /**
   * Convenience helper to emit message or thought chunks.
   */
  emitChunk(
    sessionId: string,
    text: string,
    kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk",
  ): void {
    this.emitSessionUpdate(sessionId, {
      sessionUpdate: kind,
      content: { type: "text", text },
    });
  }

  /**
   * Convenience helper to emit tool call updates.
   */
  emitToolCall(
    sessionId: string,
    toolCallId: string,
    status: "pending" | "in_progress" | "completed" | "failed",
    extra: Partial<AcpToolCallUpdate> = {},
  ): void {
    this.emitSessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      ...extra,
    });
  }

  /**
   * Send a `session/request_permission` request to the client and await outcome.
   */
  async requestPermission(
    params: AcpRequestPermissionParams,
  ): Promise<AcpRequestPermissionResult> {
    return this.connection.request<AcpRequestPermissionResult>(
      "session/request_permission",
      params,
    );
  }

  /**
   * Send an `elicitation/create` request to the client and await response.
   */
  async createElicitation(params: AcpElicitationParams): Promise<AcpElicitationResult> {
    return this.connection.request<AcpElicitationResult>("elicitation/create", params);
  }

  /**
   * Write raw data directly to the client stream to test malformed/noisy lines.
   */
  sendRaw(data: string): void {
    this.toClient.write(data.endsWith("\n") ? data : data + "\n");
  }

  /**
   * Simulate agent crash by destroying the streams.
   */
  crash(error: Error = new Error("Agent crashed unexpectedly")): void {
    if (this.activePrompt) {
      const active = this.activePrompt;
      this.activePrompt = null;
      active.reject(error);
    }
    this.toClient.destroy(error);
    this.fromClient.destroy(error);
    this.connection.close(error);
  }

  /**
   * Cleanly close agent streams.
   */
  close(): void {
    this.connection.close();
    this.toClient.end();
    this.fromClient.end();
  }

  private setupHandlers(): void {
    // 1. initialize
    this.connection.onRequest("initialize", (params) => {
      this.recordRequest("initialize", params);
      return this.initResult;
    });

    // 2. session/new
    this.connection.onRequest("session/new", (params) => {
      this.recordRequest("session/new", params);
      return this.newSessionResult;
    });

    // 3. session/resume
    this.connection.onRequest("session/resume", (params) => {
      this.recordRequest("session/resume", params);
      return this.resumeSessionResult;
    });

    // 4. session/close
    this.connection.onRequest("session/close", (params) => {
      this.recordRequest("session/close", params);
      return {};
    });

    // 5. session/set_mode
    this.connection.onRequest("session/set_mode", (params) => {
      this.recordRequest("session/set_mode", params);
      return {};
    });

    // 6. session/set_config_option
    this.connection.onRequest("session/set_config_option", (params) => {
      this.recordRequest("session/set_config_option", params);
      return {};
    });

    // 7. session/prompt
    this.connection.onRequest("session/prompt", async (params) => {
      const typedParams = params as { sessionId: string; prompt: AcpPromptContent[] };
      const reqId = this.recordedRequests.length + 1;
      this.recordRequest("session/prompt", params);

      // Handle steering: if another prompt is active, agy immediately resolves the earlier prompt
      if (this.steeringEnabled && this.activePrompt) {
        const earlier = this.activePrompt;
        this.activePrompt = null;
        earlier.resolve({ stopReason: "end_turn" });
      }

      if (this.promptHandler) {
        const { promise, resolve, reject } = Promise.withResolvers<AcpPromptResult>();
        this.activePrompt = { id: reqId, resolve, reject };
        return Promise.race([
          promise,
          Promise.resolve(this.promptHandler(typedParams, reqId)).finally(() => {
            if (this.activePrompt?.id === reqId) {
              this.activePrompt = null;
            }
          }),
        ]);
      }

      const nextResult = this.promptQueue.shift() ?? {
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 25,
          totalTokens: 35,
        },
      };

      if (this.steeringEnabled || this.shouldHoldPrompt) {
        this.shouldHoldPrompt = false;
        const { promise, resolve, reject } = Promise.withResolvers<AcpPromptResult>();
        this.activePrompt = { id: reqId, resolve, reject };
        if (this.steeringEnabled) {
          // If not superseded by steering, resolve after short delay
          setTimeout(() => {
            if (this.activePrompt?.id === reqId) {
              this.activePrompt = null;
              resolve(nextResult);
            }
          }, 50);
        }
        return promise;
      }

      return nextResult;
    });

    // 8. session/cancel notification
    this.connection.onNotification("session/cancel", (params) => {
      this.recordNotification("session/cancel", params);
      if (this.activePrompt) {
        const active = this.activePrompt;
        this.activePrompt = null;
        active.resolve({ stopReason: "cancelled" });
      }
    });
  }

  private recordRequest(method: string, params: unknown): void {
    const id = this.recordedRequests.length + 1;
    this.recordedRequests.push({ id, method, params });
  }

  private recordNotification(method: string, params: unknown): void {
    this.recordedNotifications.push({ method, params });
  }
}
