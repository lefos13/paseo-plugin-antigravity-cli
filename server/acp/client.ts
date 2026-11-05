import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { resolveAgyBinary } from "../agy";
import { JsonRpcConnection } from "./rpc";
import {
  acpElicitationParamsSchema,
  acpInitializeResultSchema,
  acpNewSessionResultSchema,
  acpPromptResultSchema,
  acpRequestPermissionParamsSchema,
  acpResumeSessionResultSchema,
  acpSessionUpdateNotificationSchema,
  type AcpElicitationParams,
  type AcpElicitationResult,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptContent,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpResumeSessionResult,
  type AcpSessionUpdate,
  type AcpSessionUpdateNotification,
} from "./schema";

export interface AgyAcpClientConfig {
  cwd: string;
  binary?: string;
  env?: Readonly<Record<string, string>>;
  skipPermissions?: boolean;
  extraArgs?: readonly string[];
}

export interface AgyAcpClientTransport {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface AgyAcpClientOptions {
  connection?: JsonRpcConnection;
  transport?: AgyAcpClientTransport;
  onRequestPermission?: (
    params: AcpRequestPermissionParams,
  ) => Promise<AcpRequestPermissionResult> | AcpRequestPermissionResult;
  onElicitation?: (
    params: AcpElicitationParams,
  ) => Promise<AcpElicitationResult> | AcpElicitationResult;
  maxStderrLines?: number;
}

export interface AgyAcpNewSessionOptions {
  cwd: string;
  mcpServers?: unknown[];
  systemPromptAppend?: string;
}

export interface AgyAcpResumeSessionOptions {
  sessionId: string;
  cwd: string;
  mcpServers?: unknown[];
  systemPromptAppend?: string;
}

export interface AgyAcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type RequestPermissionHandler = (
  params: AcpRequestPermissionParams,
) => Promise<AcpRequestPermissionResult> | AcpRequestPermissionResult;

export type ElicitationHandler = (
  params: AcpElicitationParams,
) => Promise<AcpElicitationResult> | AcpElicitationResult;

const DEFAULT_STDERR_TAIL_LINES = 100;
const SIGKILL_GRACE_MS = 3_000;

/**
 * High-level ACP client that manages an Antigravity CLI process running in ACP mode (`agy acp`).
 *
 * Responsibilities:
 * - Spawns `agy acp` with the session's cwd and shadow home env, or connects to an injected transport.
 * - Manages session lifecycle (`initialize`, `newSession`, `resumeSession`, `closeSession`).
 * - Sends prompt turns with support for mid-turn steering (sending a second `prompt()` while one is running).
 * - Delivers session updates via a typed event emitter.
 * - Handles incoming agent requests for user permissions (`session/request_permission`) and
 *   interactive questions (`elicitation/create`) through pluggable handlers.
 * - Exposes stderr tail diagnostics and lifecycle events (`exit`, `crash`, `close`).
 */
export class AgyAcpClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private connection: JsonRpcConnection | null = null;
  private currentSessionId: string | null = null;
  private initResult: AcpInitializeResult | null = null;
  private disposed = false;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private readonly stderrBuffer: string[] = [];
  private readonly maxStderrLines: number;

  private requestPermissionHandler?: RequestPermissionHandler;
  private elicitationHandler?: ElicitationHandler;

  constructor(
    private readonly config: AgyAcpClientConfig,
    private readonly options: AgyAcpClientOptions = {},
  ) {
    super();
    this.maxStderrLines = options.maxStderrLines ?? DEFAULT_STDERR_TAIL_LINES;
    this.requestPermissionHandler = options.onRequestPermission;
    this.elicitationHandler = options.onElicitation;

    if (options.connection) {
      this.attachConnection(options.connection);
    } else if (options.transport) {
      const conn = new JsonRpcConnection(options.transport.input, options.transport.output);
      this.attachConnection(conn);
    }
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  get running(): boolean {
    return this.connection !== null && !this.connection.isClosed && !this.disposed;
  }

  get stderrTail(): readonly string[] {
    return [...this.stderrBuffer];
  }

  /**
   * Set or update the handler for incoming `session/request_permission` requests.
   */
  setRequestPermissionHandler(handler: RequestPermissionHandler): void {
    this.requestPermissionHandler = handler;
  }

  /**
   * Set or update the handler for incoming `elicitation/create` requests.
   */
  setElicitationHandler(handler: ElicitationHandler): void {
    this.elicitationHandler = handler;
  }

  /**
   * Explicitly launch `agy acp` if not already started.
   */
  start(): void {
    if (this.disposed) throw new Error("AgyAcpClient has been disposed");
    if (this.connection) return;

    const binary = resolveAgyBinary(this.config.binary);
    const args = ["acp"];
    if (this.config.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (this.config.extraArgs) {
      args.push(...this.config.extraArgs);
    }

    const child = spawn(binary, args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    if (child.stderr) {
      const reader = createInterface({ input: child.stderr });
      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          this.recordStderr(trimmed);
          this.emit("stderr", trimmed);
        }
      });
    }

    child.stdin?.on("error", (error) => {
      this.recordStderr(`agy acp stdin error: ${error.message}`);
    });

    child.on("error", (error) => {
      this.recordStderr(`failed to launch ${binary}: ${error.message}`);
      this.emit("crash", error);
      this.connection?.close(error);
      this.resolveExit?.();
      this.resolveExit = null;
      this.child = null;
    });

    child.on("exit", (code, signal) => {
      const exitInfo: AgyAcpExitInfo = { code, signal };
      this.emit("exit", exitInfo);

      if (code !== 0 && code !== null) {
        const tailSummary =
          this.stderrBuffer.length > 0
            ? `:\n${this.stderrBuffer.slice(-5).join("\n")}`
            : "";
        const err = new Error(
          `agy acp exited with code ${code}${signal ? ` (signal ${signal})` : ""}${tailSummary}`,
        );
        this.connection?.close(err);
      } else {
        this.connection?.close(new Error("agy acp process exited"));
      }

      this.resolveExit?.();
      this.resolveExit = null;
      this.child = null;
    });

    if (!child.stdout || !child.stdin) {
      throw new Error("Failed to open stdio pipes for agy acp process");
    }

    const conn = new JsonRpcConnection(child.stdout, child.stdin);
    this.attachConnection(conn);
  }

  /**
   * Run the initialize handshake (`initialize`).
   */
  async initialize(): Promise<AcpInitializeResult> {
    this.ensureConnection();
    if (this.initResult) return this.initResult;

    const raw = await this.connection!.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });

    const parsed = acpInitializeResultSchema.parse(raw);
    this.initResult = parsed;
    return parsed;
  }

  /**
   * Open a new ACP session (`session/new`).
   */
  async newSession(options: AgyAcpNewSessionOptions): Promise<AcpNewSessionResult> {
    this.ensureConnection();

    const params: Record<string, unknown> = {
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    };
    if (options.systemPromptAppend) {
      params._meta = {
        antigravity: {
          systemPrompt: {
            append: options.systemPromptAppend,
          },
        },
      };
    }

    const raw = await this.connection!.request("session/new", params);
    const parsed = acpNewSessionResultSchema.parse(raw);
    this.currentSessionId = parsed.sessionId;
    return parsed;
  }

  /**
   * Resume an existing ACP session by conversation ID (`session/resume`).
   */
  async resumeSession(options: AgyAcpResumeSessionOptions): Promise<AcpResumeSessionResult> {
    this.ensureConnection();

    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    };
    if (options.systemPromptAppend) {
      params._meta = {
        antigravity: {
          systemPrompt: {
            append: options.systemPromptAppend,
          },
        },
      };
    }

    const raw = await this.connection!.request("session/resume", params);
    const parsed = acpResumeSessionResultSchema.parse(raw);
    this.currentSessionId = options.sessionId;
    return parsed;
  }

  /**
   * Close the active session (`session/close`).
   */
  async closeSession(): Promise<void> {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    this.currentSessionId = null;

    if (this.connection && !this.connection.isClosed) {
      try {
        await this.connection.request("session/close", { sessionId });
      } catch {
        // Safe to ignore on close if the process or session is already gone
      }
    }
  }

  /**
   * Send a prompt to the current session (`session/prompt`).
   *
   * Note on steering: If called while another prompt is in flight, both calls
   * proceed independently over JSON-RPC. Agy resolves the earlier turn with
   * `stopReason: "end_turn"` (no usage), and completes the work on the steering prompt.
   */
  async prompt(content: AcpPromptContent[]): Promise<AcpPromptResult> {
    this.ensureConnection();
    const sessionId = this.currentSessionId;
    if (!sessionId) {
      throw new Error("No active ACP session; call newSession() or resumeSession() first");
    }

    const raw = await this.connection!.request("session/prompt", {
      sessionId,
      prompt: content,
    });

    return acpPromptResultSchema.parse(raw);
  }

  /**
   * Cancel the currently running prompt (`session/cancel`).
   */
  cancel(): void {
    const sessionId = this.currentSessionId;
    if (!sessionId || !this.connection) return;
    this.connection.notify("session/cancel", { sessionId });
  }

  /**
   * Change the session mode (e.g. "default", "plan", "accept-edits").
   */
  async setMode(modeId: string): Promise<void> {
    this.ensureConnection();
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error("No active ACP session");

    await this.connection!.request("session/set_mode", {
      sessionId,
      modeId,
    });
  }

  /**
   * Set a configuration option for the session (e.g. "model" or "thought_level").
   */
  async setConfigOption(
    configId: string,
    value: string | boolean | number,
  ): Promise<void> {
    this.ensureConnection();
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error("No active ACP session");

    await this.connection!.request("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
  }

  /**
   * Terminate the client, closing any active session, the RPC connection, and the child process.
   */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    try {
      await this.closeSession();
    } catch {
      // Ignored during teardown
    }

    if (this.connection) {
      this.connection.close(new Error("AgyAcpClient closed"));
    }

    if (this.child) {
      this.child.stdin?.end();
      this.child.kill("SIGKILL");
      if (this.exitPromise) {
        await Promise.race([this.exitPromise, delay(SIGKILL_GRACE_MS)]);
      }
      this.child = null;
    }

    this.emit("close");
  }

  private ensureConnection(): void {
    if (this.disposed) throw new Error("AgyAcpClient has been disposed");
    if (!this.connection) {
      this.start();
    }
  }

  private attachConnection(conn: JsonRpcConnection): void {
    this.connection = conn;

    // 1. Session Updates (streamed notifications from agy)
    conn.onNotification("session/update", (params) => {
      const parsed = acpSessionUpdateNotificationSchema.safeParse(params);
      if (parsed.success) {
        this.emit("sessionUpdate", parsed.data);
        this.emit("update", parsed.data.update, parsed.data.sessionId);
      } else if (typeof params === "object" && params !== null) {
        const rec = params as Record<string, unknown>;
        const sessionId =
          typeof rec.sessionId === "string" ? rec.sessionId : (this.currentSessionId ?? "");
        const update = (rec.update ?? rec) as AcpSessionUpdate;
        this.emit("sessionUpdate", { sessionId, update });
        this.emit("update", update, sessionId);
      }
    });

    // 2. Incoming request: session/request_permission
    conn.onRequest("session/request_permission", async (params) => {
      const parsed = acpRequestPermissionParamsSchema.parse(params);
      if (this.requestPermissionHandler) {
        return this.requestPermissionHandler(parsed);
      }
      return { outcome: { outcome: "cancelled" } };
    });

    // 3. Incoming request: elicitation/create (ask_question)
    conn.onRequest("elicitation/create", async (params) => {
      const parsed = acpElicitationParamsSchema.parse(params);
      if (this.elicitationHandler) {
        return this.elicitationHandler(parsed);
      }
      return { action: "cancel" };
    });

    conn.on("close", (err) => {
      this.emit("close", err);
    });
  }

  private recordStderr(line: string): void {
    this.stderrBuffer.push(line);
    if (this.stderrBuffer.length > this.maxStderrLines) {
      this.stderrBuffer.shift();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
