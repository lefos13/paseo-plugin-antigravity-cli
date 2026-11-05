import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

/**
 * Standard JSON-RPC 2.0 error codes and custom Antigravity ACP error representation.
 */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: TResult;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string;
  error: JsonRpcErrorPayload;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
}

/**
 * Bidirectional JSON-RPC 2.0 connection over a pair of Readable and Writable streams.
 *
 * Designed specifically for Antigravity CLI ACP (`agy acp`):
 * - Uses newline-delimited JSON (`\n`) over stdio streams.
 * - Generates incrementing numeric request IDs (1, 2, 3...) for outgoing requests.
 * - Handles incoming requests from the agent with string or numeric IDs (e.g., "1").
 * - Supports concurrent requests and out-of-order responses (essential for turn steering).
 * - Tolerates malformed lines, empty lines, and non-JSON noise on stdout without crashing.
 * - Rejects all pending requests with a descriptive error when closed or on stream errors.
 */
export class JsonRpcConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly readline: Interface;
  private closed = false;
  private closeError: Error | null = null;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    super();

    this.readline = createInterface({
      input: this.input,
      crlfDelay: Infinity,
      terminal: false,
    });

    this.readline.on("line", (line) => this.handleLine(line));

    // Handle stream closure and errors gracefully
    this.readline.on("error", (err: Error) => {
      this.readline.close();
      this.teardown(err);
    });

    const scheduleTeardown = (defaultError: Error) => {
      const timer = setTimeout(() => {
        const streamErr =
          (this.input as { errored?: Error }).errored ??
          (this.output as { errored?: Error }).errored;
        this.teardown(this.closeError ?? streamErr ?? defaultError);
      }, 50);
      timer.unref?.();
    };

    this.readline.on("close", () => {
      scheduleTeardown(new Error("JSON-RPC connection closed"));
    });

    this.input.on("error", (err: Error) => {
      this.readline.close();
      this.teardown(this.closeError ?? err);
    });

    this.input.on("close", () => {
      this.readline.close();
      scheduleTeardown(new Error("JSON-RPC input stream closed"));
    });

    this.input.on("end", () => {
      this.readline.close();
      scheduleTeardown(new Error("JSON-RPC input stream ended"));
    });

    this.output.on("error", (err: Error) => {
      this.teardown(new Error(`Output stream error: ${err.message}`));
    });

    this.output.on("close", () => {
      scheduleTeardown(new Error("JSON-RPC output stream closed"));
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send a JSON-RPC request and wait for the corresponding response.
   *
   * Assigns a numeric ID and correlates the response asynchronously.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw this.closeError ?? new Error(`Cannot send request "${method}" on closed connection`);
    }

    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();

    this.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      method,
    });

    const msg: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      msg.params = params;
    }

    try {
      await this.write(msg);
    } catch (err) {
      this.pending.delete(id);
      const errorObj = err instanceof Error ? err : new Error(String(err));
      reject(errorObj);
    }

    return promise;
  }

  /**
   * Send a one-way notification without an ID (fire-and-forget).
   */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;

    const msg: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      msg.params = params;
    }

    this.write(msg).catch(() => {
      // Notification errors are ignored as the connection error listener catches stream errors.
    });
  }

  /**
   * Send a success response to an incoming request from the agent.
   */
  async respond(id: number | string, result: unknown): Promise<void> {
    if (this.closed) return;
    await this.write({
      jsonrpc: "2.0",
      id,
      result: result ?? null,
    });
  }

  /**
   * Send an error response to an incoming request from the agent.
   */
  async respondError(
    id: number | string,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    if (this.closed) return;
    const errorPayload: JsonRpcErrorPayload = { code, message };
    if (data !== undefined) errorPayload.data = data;

    await this.write({
      jsonrpc: "2.0",
      id,
      error: errorPayload,
    });
  }

  /**
   * Register a handler for incoming requests with the given method name.
   */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Register a handler for incoming notifications with the given method name.
   */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  /**
   * Close the connection and reject all in-flight pending requests.
   */
  close(error?: Error): void {
    if (this.closed) return;
    this.closeError = error ?? new Error("JSON-RPC connection closed");
    this.readline.close();
    this.teardown(this.closeError);
  }

  private teardown(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;

    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
    this.emit("close", err);
  }

  private async write(msg: unknown): Promise<void> {
    if (this.closed) {
      throw this.closeError ?? new Error("Connection is closed");
    }

    const json = JSON.stringify(msg);
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    const ok = this.output.write(json + "\n", "utf8", (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });

    if (!ok) {
      // Backpressure handled by the write callback
    }

    return promise;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed lines are tolerated and ignored to protect against CLI banners or noisy logs.
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;

    // 1. Is this a response to an outgoing request we sent?
    // A response contains an `id` and either `result` or `error`.
    if (
      record.id !== undefined &&
      ("result" in record || "error" in record) &&
      !("method" in record)
    ) {
      this.handleResponse(record.id as number | string, record.result, record.error);
      return;
    }

    // 2. Is this an incoming request from the agent?
    // A request has a `method` and an `id`.
    if (typeof record.method === "string" && record.id !== undefined) {
      this.handleIncomingRequest(
        record.id as number | string,
        record.method,
        record.params,
      ).catch(() => {
        // Write failures on a closed connection or dying agent are safely dropped.
      });
      return;
    }

    // 3. Is this an incoming notification from the agent?
    // A notification has a `method` and NO `id`.
    if (typeof record.method === "string" && record.id === undefined) {
      this.handleIncomingNotification(record.method, record.params);
      return;
    }
  }

  private handleResponse(id: number | string, result: unknown, error: unknown): void {
    // Request IDs sent by us are numbers, but correlation checks both number and string conversions
    // to handle agents that might echo numeric IDs as strings or vice-versa.
    let pending = this.pending.get(id);
    if (!pending && typeof id === "string") {
      const numId = Number(id);
      if (!Number.isNaN(numId)) pending = this.pending.get(numId);
    } else if (!pending && typeof id === "number") {
      pending = this.pending.get(String(id));
    }

    if (!pending) {
      // Uncorrelated response (cancelled, timed out, or extraneous); silently drop.
      return;
    }

    this.pending.delete(id);
    if (typeof id === "string") this.pending.delete(Number(id));
    if (typeof id === "number") this.pending.delete(String(id));

    if (error && typeof error === "object") {
      const errRecord = error as Record<string, unknown>;
      const code = typeof errRecord.code === "number" ? errRecord.code : JSON_RPC_ERRORS.INTERNAL_ERROR;
      const message = typeof errRecord.message === "string" ? errRecord.message : "JSON-RPC error";
      pending.reject(new JsonRpcError(code, message, errRecord.data));
      return;
    }

    pending.resolve(result);
  }

  private async handleIncomingRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      try {
        await this.respondError(
          id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        );
      } catch {
        // Drop write failures on closed connection or dying stream
      }
      return;
    }

    try {
      const result = await handler(params);
      await this.respond(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof JsonRpcError ? err.code : JSON_RPC_ERRORS.INTERNAL_ERROR;
      const data = err instanceof JsonRpcError ? err.data : undefined;
      try {
        await this.respondError(id, code, message, data);
      } catch {
        // Drop write failures on closed connection or dying stream
      }
    }
  }

  private handleIncomingNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(params);
        } catch (err) {
          console.error(`[acp-rpc] Error in notification handler for "${method}":`, err);
        }
      }
    }
    this.emit("notification", method, params);
  }
}
