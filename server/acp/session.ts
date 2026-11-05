import { randomUUID } from "node:crypto";
import type {
  ProviderCapability,
  ProviderCommand,
  ProviderConnection,
  ProviderContent,
  ProviderEvent,
  ProviderInput,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { requireProviderCapabilities } from "@getpaseo/plugin/server/provider";
import { resolveAgyBinary } from "../agy";
import {
  accountGeminiRoot,
  accountHome,
  readAccounts,
  syncShadowHome,
} from "../accounts";
import { readToolPermission } from "../agysettings";
import { buildCatalog, DEFAULT_MODE_ID } from "../catalog";
import { discoverCommands, SYSTEM_COMMANDS, type AgyCommand } from "../commands";
import { listConversations } from "../sessions";
import { mapToolDetail } from "../tools";
import { TranscriptStore, transcriptExists } from "../transcript";
import {
  ACP_CAPABILITIES,
  approvalPolicy,
  configState,
  emitNotice,
  persistenceField,
  persistenceFor,
  readProviderOptions,
  renderPart,
  resolveAccountId,
  turnFailure,
  type ConfigStateSession,
} from "../provider";
import {
  AgyAcpClient,
  type AgyAcpClientConfig,
  type AgyAcpClientOptions,
  type AgyAcpClientTransport,
} from "./client";
import type {
  AcpAvailableCommandsUpdate,
  AcpCurrentModeUpdate,
  AcpMessageChunkUpdate,
  AcpPromptContent,
  AcpPromptResult,
  AcpSessionInfoUpdate,
  AcpSessionUpdate,
  AcpToolCallUpdate,
  AcpUsage,
} from "./schema";

export type Emit = (event: ProviderEvent) => void;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ProviderToolCallItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_COMMANDS = 128;

const KNOWN_VENDOR_TOOLS = new Set([
  "run_command",
  "command_status",
  "manage_task",
  "view_file",
  "read_resource",
  "write_to_file",
  "replace_file_content",
  "sed_file",
  "multi_replace_file_content",
  "call_mcp_tool",
  "grep_search",
  "find_by_name",
  "list_dir",
  "search_web",
  "read_url_content",
  "invoke_subagent",
  "define_subagent",
]);

/**
 * Maps an incoming ACP tool call update onto Paseo's ProviderToolCallDetail.
 * Uses agy vendor fields first, falling back to standard ACP fields (kind, title, locations, content/diff).
 */
export function mapAcpToolDetail(
  update: AcpToolCallUpdate,
  cwd: string,
): ProviderToolCallDetail {
  // 1. Vendor name/args path
  if (update.name && KNOWN_VENDOR_TOOLS.has(update.name)) {
    const rawArgs =
      typeof update.args === "object" && update.args !== null && !Array.isArray(update.args)
        ? (update.args as Record<string, unknown>)
        : typeof update.rawInput === "object" && update.rawInput !== null && !Array.isArray(update.rawInput)
          ? (update.rawInput as Record<string, unknown>)
          : undefined;
    const output = typeof update.rawOutput === "string" ? update.rawOutput : undefined;
    return mapToolDetail(update.name, { parameters: rawArgs, output }, cwd);
  }

  // 2. Standard ACP fallback path: check for diff content
  if (Array.isArray(update.content)) {
    for (const c of update.content) {
      if (c && typeof c === "object" && c.type === "diff") {
        const diffPath = typeof c.path === "string" ? c.path : update.locations?.[0]?.path ?? "";
        const oldText = typeof c.oldText === "string" ? c.oldText : undefined;
        const newText = typeof c.newText === "string" ? c.newText : undefined;
        return {
          type: "edit",
          filePath: diffPath,
          ...(oldText !== undefined ? { oldString: oldText } : {}),
          ...(newText !== undefined ? { newString: newText } : {}),
        };
      }
    }
  }

  const firstLocation = update.locations?.[0]?.path;
  if (update.kind === "execute" || update.kind === "terminal") {
    const command = update.title ?? (typeof update.rawInput === "string" ? update.rawInput : "");
    return {
      type: "shell",
      command: command || "execute",
      cwd,
      output: typeof update.rawOutput === "string" ? update.rawOutput : undefined,
    };
  }

  if (update.kind === "read") {
    return {
      type: "read",
      filePath: firstLocation ?? update.title ?? "",
      content: typeof update.rawOutput === "string" ? update.rawOutput : undefined,
    };
  }

  if (update.kind === "edit") {
    return {
      type: "edit",
      filePath: firstLocation ?? update.title ?? "",
    };
  }

  if (update.kind === "write") {
    return {
      type: "write",
      filePath: firstLocation ?? update.title ?? "",
      content: typeof update.rawOutput === "string" ? update.rawOutput : undefined,
    };
  }

  // Fallback to plain_text
  const label = update.title ?? update.name ?? update.kind ?? "tool";
  const text =
    typeof update.rawOutput === "string"
      ? update.rawOutput
      : typeof update.rawInput === "string"
        ? update.rawInput
        : "";
  return {
    type: "plain_text",
    label,
    text,
  };
}

/**
 * Merges ACP available commands with Paseo system commands, preserving system command
 * precedence and commands.ts duplicate collision handling (first occurrence wins).
 */
export function mergeAvailableCommands(
  availableCommands: Array<{ name?: string; description?: string }>,
): ProviderCommand[] {
  const map = new Map<string, ProviderCommand>();
  for (const cmd of SYSTEM_COMMANDS) {
    map.set(cmd.name, {
      name: cmd.name,
      description: cmd.description,
    });
  }
  for (const cmd of availableCommands) {
    if (!cmd.name) continue;
    const baseName = cmd.name.trim();
    if (!baseName) continue;

    let candidateName = baseName;
    let counter = 2;
    while (map.has(candidateName)) {
      candidateName = `${baseName} (${counter})`;
      counter += 1;
    }

    if (map.size >= MAX_COMMANDS) break;
    map.set(candidateName, {
      name: candidateName,
      description: cmd.description?.trim() ?? "",
    });
  }
  return [...map.values()];
}

/**
 * Maps ACP prompt usage to Paseo ProviderUsage format.
 */
export function toProviderUsageFromAcp(usage: AcpUsage): ProviderUsage {
  const outputTokens = (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedReadTokens,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
  };
}

/**
 * Converts a Paseo ProviderPrompt into ACP AcpPromptContent array and display text.
 */
export function toAcpPromptContent(prompt: ProviderPrompt): {
  content: AcpPromptContent[];
  shown: string;
} {
  if (prompt.input.type === "command") {
    const args = prompt.input.arguments.trim();
    const text = args.length > 0 ? `/${prompt.input.name} ${args}` : `/${prompt.input.name}`;
    return {
      content: [{ type: "text", text }],
      shown: text,
    };
  }

  const contents: AcpPromptContent[] = [];
  const shownParts: string[] = [];

  for (const part of prompt.input.content) {
    if (part.type === "text") {
      contents.push({ type: "text", text: part.text });
      shownParts.push(part.text);
    } else if (part.type === "image") {
      contents.push({
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      });
      shownParts.push(`[image (${part.mimeType})]`);
    } else if (part.type === "uploaded_file") {
      const text = `[uploaded file: ${part.path} (${part.fileName}, ${part.mimeType})]`;
      contents.push({ type: "text", text });
      shownParts.push(text);
    } else {
      const rendered = renderPart(part);
      if (rendered.length > 0) {
        contents.push({ type: "text", text: rendered });
        shownParts.push(rendered);
      }
    }
  }

  return {
    content: contents,
    shown: shownParts.join("\n\n"),
  };
}

export interface AcpActiveTurn {
  readonly turnId: string;
  readonly clientMessageId: string;
  currentMessageId: string;
  currentMessageText: string;
  currentThoughtId: string;
  currentThoughtText: string;
  messageIndex: number;
  thoughtIndex: number;
  readonly openTools: Map<string, ProviderToolCallItem>;
  activePromptPromise: Promise<AcpPromptResult>;
}

export class AcpSession implements ConfigStateSession {
  readonly sessionId: string;
  readonly config: ProviderSessionConfig;
  readonly accountId: string;
  readonly persist: boolean;
  conversationId: string | null;
  selection: { model?: string; mode?: string; thinkingOption?: string };
  settings: Record<string, JsonValue>;
  title?: string;
  transcript: TranscriptStore | null = null;
  client: AgyAcpClient | null = null;
  launchPromise: Promise<AgyAcpClient> | null = null;
  activeTurn: AcpActiveTurn | null = null;
  turnCounter = 0;
  interrupting = false;
  closing = false;
  commands: ProviderCommand[] = [];

  // Optional transport provider for scripted testing
  injectedTransport?: AgyAcpClientTransport | (() => AgyAcpClientTransport);

  constructor(
    sessionId: string,
    config: ProviderSessionConfig,
    conversationId: string | null,
    accountId: string,
    injectedTransport?: AgyAcpClientTransport | (() => AgyAcpClientTransport),
  ) {
    this.sessionId = sessionId;
    this.config = config;
    this.conversationId = conversationId;
    this.accountId = accountId;
    this.persist = config.persist !== false;
    this.selection = {
      model: config.model,
      mode: config.mode ?? DEFAULT_MODE_ID,
      thinkingOption: config.thinkingOption,
    };
    this.settings = { ...config.settings };
    this.title = config.title;
    this.injectedTransport = injectedTransport;
  }
}

interface AcpConnectionState {
  capabilities: readonly ProviderCapability[];
  sessions: Map<string, AcpSession>;
}

export interface AcpConnectionOptions {
  clientFactory?: (config: AgyAcpClientConfig, options: AgyAcpClientOptions) => AgyAcpClient;
  transport?: AgyAcpClientTransport | (() => AgyAcpClientTransport);
}

function publish(session: AcpSession, emit: Emit, item: ProviderTimelineItem): void {
  if (session.transcript) {
    session.transcript.upsert(item);
  }
  emit({
    type: "timeline.item",
    sessionId: session.sessionId,
    item,
  });
}

function requireAcpSession(state: AcpConnectionState, sessionId: string): AcpSession {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

function resolveToolItem(
  toolUpdate: AcpToolCallUpdate,
  previous: ProviderToolCallItem | undefined,
  cwd: string,
): ProviderToolCallItem {
  const callId = toolUpdate.toolCallId;
  let detail = mapAcpToolDetail(toolUpdate, cwd);
  let name = toolUpdate.name ?? toolUpdate.title ?? toolUpdate.kind;

  if (previous) {
    if (!name) name = previous.name;
    if (detail.type === "plain_text" && previous.detail.type !== "plain_text") {
      if (typeof toolUpdate.rawOutput === "string") {
        if (previous.detail.type === "shell") {
          detail = { ...previous.detail, output: toolUpdate.rawOutput };
        } else if (previous.detail.type === "read") {
          detail = { ...previous.detail, content: toolUpdate.rawOutput };
        } else if (previous.detail.type === "edit") {
          detail = { ...previous.detail };
        } else if (previous.detail.type === "write") {
          detail = { ...previous.detail };
        } else {
          detail = previous.detail;
        }
      } else {
        detail = previous.detail;
      }
    }
  }

  const finalName = name ?? "tool";
  let status: "running" | "completed" | "failed";
  let error: JsonValue = null;

  if (toolUpdate.status === "completed") {
    status = "completed";
  } else if (toolUpdate.status === "failed") {
    status = "failed";
    error = (toolUpdate.rawOutput as JsonValue) ?? "Tool failed";
  } else {
    status = "running";
  }

  if (status === "failed") {
    return {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name: finalName,
      detail,
      status: "failed",
      error,
    };
  }

  return {
    type: "tool_call",
    id: `tool:${callId}`,
    callId,
    name: finalName,
    detail,
    status,
    error: null,
  };
}

function handleSessionUpdate(session: AcpSession, update: AcpSessionUpdate, emit: Emit): void {
  const turn = session.activeTurn;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (!turn) return;
      const chunk = update as AcpMessageChunkUpdate;
      const text = chunk.content?.text ?? "";
      if (text.length === 0) return;
      turn.currentMessageText += text;
      publish(session, emit, {
        type: "assistant_message",
        id: turn.currentMessageId,
        text: turn.currentMessageText,
      });
      break;
    }

    case "agent_thought_chunk": {
      if (!turn) return;
      const chunk = update as AcpMessageChunkUpdate;
      const text = chunk.content?.text ?? "";
      if (text.length === 0) return;
      turn.currentThoughtText += text;
      publish(session, emit, {
        type: "reasoning",
        id: turn.currentThoughtId,
        text: turn.currentThoughtText,
      });
      break;
    }

    case "user_message_chunk":
      // Echoed user message chunk; ignored.
      break;

    case "tool_call":
    case "tool_call_update": {
      if (!turn) {
        // TODO(acp-3c): Detached turns after end_turn
        return;
      }
      const toolUpdate = update as AcpToolCallUpdate;
      const callId = toolUpdate.toolCallId;
      const previous = turn.openTools.get(callId);
      const item = resolveToolItem(toolUpdate, previous, session.config.cwd);

      if (item.status === "running") {
        turn.openTools.set(callId, item);
      } else {
        turn.openTools.delete(callId);
      }

      publish(session, emit, item);
      break;
    }

    case "available_commands_update": {
      const cmdUpdate = update as AcpAvailableCommandsUpdate;
      const merged = mergeAvailableCommands(cmdUpdate.availableCommands ?? []);
      session.commands = merged;
      emit({
        type: "session.commands",
        sessionId: session.sessionId,
        commands: merged,
      });
      break;
    }

    case "session_info_update": {
      const infoUpdate = update as AcpSessionInfoUpdate;
      if (typeof infoUpdate.title === "string") {
        session.title = infoUpdate.title;
      }
      break;
    }

    case "current_mode_update": {
      const modeUpdate = update as AcpCurrentModeUpdate;
      if (typeof modeUpdate.currentModeId === "string") {
        session.selection.mode = modeUpdate.currentModeId;
        emit({
          type: "session.config",
          sessionId: session.sessionId,
          config: configState(session),
        });
      }
      break;
    }

    case "config_option_update": {
      emit({
        type: "session.config",
        sessionId: session.sessionId,
        config: configState(session),
      });
      break;
    }
  }
}

function handleProcessExitOrCrash(session: AcpSession, error: Error, emit: Emit): void {
  const turn = session.activeTurn;
  const client = session.client;
  session.client = null;

  if (turn) {
    session.activeTurn = null;

    for (const tool of turn.openTools.values()) {
      publish(
        session,
        emit,
        session.interrupting
          ? { ...tool, status: "canceled", error: null }
          : { ...tool, status: "failed", error: "Process exited unexpectedly" },
      );
    }
    turn.openTools.clear();

    if (session.interrupting) {
      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId: turn.turnId,
        state: "canceled",
      });
    } else {
      const stderr = client?.stderrTail.slice(-5).join("\n") ?? "";
      const message = stderr.length > 0 ? stderr : error.message;
      const failure = turnFailure({ agyError: null }, { message, code: "agy_exit" });

      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId: turn.turnId,
        state: "failed",
        error: failure.error,
      });
    }
  }
}

async function ensureClient(session: AcpSession, emit: Emit): Promise<AgyAcpClient> {
  if (session.client?.running && session.client.sessionId) {
    return session.client;
  }
  if (session.launchPromise) {
    return session.launchPromise;
  }

  const launch = (async () => {
    try {
      const options = readProviderOptions(session.config);
      const binary = options.agyPath ?? resolveAgyBinary();
      const home = accountHome(session.accountId);
      if (home !== null) syncShadowHome(session.accountId);

      const env = home === null ? session.config.env : { ...session.config.env, HOME: home };
      const perm = readToolPermission(accountGeminiRoot(session.accountId));
      const skipPermissions =
        approvalPolicy(session) === "skip" || perm === "always-proceed";

      const rawTransport =
        session.injectedTransport ??
        (session.config.providerOptions as Record<string, unknown> | undefined)?.transport ??
        (session.config.providerOptions as Record<string, unknown> | undefined)?.acpTransport;
      const transport =
        typeof rawTransport === "function" ? (rawTransport as () => AgyAcpClientTransport)() : (rawTransport as AgyAcpClientTransport | undefined);

      const client = new AgyAcpClient(
        {
          cwd: session.config.cwd,
          binary,
          env,
          skipPermissions,
          extraArgs: options.extraArgs,
        },
        {
          transport,
          onRequestPermission: async () => {
            // TODO(acp-3b): Permission cards
            return { outcome: { outcome: "cancelled" } };
          },
          onElicitation: async () => {
            // TODO(acp-3b): Question cards
            return { action: "cancel" };
          },
        },
      );

      session.client = client;

      client.on("sessionUpdate", (notif) => {
        handleSessionUpdate(session, notif.update, emit);
      });

      client.on("crash", (error) => {
        handleProcessExitOrCrash(session, error, emit);
      });

      client.on("exit", (info) => {
        if (info.code !== 0 && info.code !== null) {
          handleProcessExitOrCrash(
            session,
            new Error(`agy acp exited with code ${info.code}${info.signal ? ` (signal ${info.signal})` : ""}`),
            emit,
          );
        }
      });

      await client.initialize();

      if (session.conversationId) {
        await client.resumeSession({
          sessionId: session.conversationId,
          cwd: session.config.cwd,
          mcpServers: [], // TODO(acp-3c): Native MCP sharing via mcpServers
          systemPromptAppend: session.config.systemPrompt,
        });
      } else {
        const res = await client.newSession({
          cwd: session.config.cwd,
          mcpServers: [], // TODO(acp-3c): Native MCP sharing via mcpServers
          systemPromptAppend: session.config.systemPrompt,
        });
        session.conversationId = res.sessionId;
        if (session.persist) {
          session.transcript = new TranscriptStore(session.conversationId);
        }
        emit({
          type: "session.persistence",
          sessionId: session.sessionId,
          persistence: persistenceFor(session.conversationId, session.accountId),
        });
      }

      // Set initial mode / model / thinking options if specified in session.selection
      if (session.selection.mode && session.selection.mode !== "default") {
        try {
          await client.setMode(session.selection.mode);
        } catch {
          // Best-effort at session startup
        }
      }
      if (session.selection.model) {
        try {
          await client.setConfigOption("model", session.selection.model);
        } catch {
          // Best-effort at session startup
        }
      }
      if (session.selection.thinkingOption) {
        try {
          await client.setConfigOption("thought_level", session.selection.thinkingOption);
        } catch {
          // Best-effort at session startup
        }
      }

      return client;
    } finally {
      session.launchPromise = null;
    }
  })();

  session.launchPromise = launch;
  return launch;
}

async function runTurnPrompt(
  session: AcpSession,
  turn: AcpActiveTurn,
  thisPromptPromise: Promise<AcpPromptResult>,
  emit: Emit,
): Promise<void> {
  try {
    const result = await thisPromptPromise;

    // Check if this prompt was superseded by a later steering prompt
    if (turn.activePromptPromise !== thisPromptPromise) {
      // Ignored: early end_turn without usage
      return;
    }

    session.activeTurn = null;

    if (result.usage) {
      emit({
        type: "session.usage",
        sessionId: session.sessionId,
        turnId: turn.turnId,
        usage: toProviderUsageFromAcp(result.usage),
      });
    }

    if (result.stopReason === "cancelled" || session.interrupting) {
      session.interrupting = false;
      for (const tool of turn.openTools.values()) {
        publish(session, emit, {
          ...tool,
          status: "canceled",
          error: null,
        });
      }
      turn.openTools.clear();

      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId: turn.turnId,
        state: "canceled",
      });
    } else {
      const BACKGROUND_NOTE =
        "Still running in the background when the turn ended — Antigravity sees its result on your next message.";

      for (const tool of turn.openTools.values()) {
        const detail = { ...tool.detail };
        if (detail.type === "shell") {
          detail.output = detail.output
            ? `${detail.output}\n\n[${BACKGROUND_NOTE}]`
            : BACKGROUND_NOTE;
        } else if (detail.type === "plain_text") {
          detail.text = detail.text
            ? `${detail.text}\n\n[${BACKGROUND_NOTE}]`
            : BACKGROUND_NOTE;
        }

        publish(session, emit, {
          ...tool,
          detail,
          status: "completed",
          error: null,
        });
      }
      turn.openTools.clear();

      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId: turn.turnId,
        state: "completed",
      });
    }
  } catch (err) {
    if (turn.activePromptPromise !== thisPromptPromise) {
      return;
    }
    handleProcessExitOrCrash(session, err instanceof Error ? err : new Error(String(err)), emit);
  }
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  session: AcpSession,
  emit: Emit,
): Promise<void> {
  const { prompt } = input;

  if (prompt.outputSchema !== undefined) {
    // TODO(acp-3b): Structured output via one-shot -p fallback
    emit({
      type: "session.prompt_result",
      sessionId: session.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: {
        type: "failed",
        error: {
          message: "Structured output is not supported over ACP yet",
          code: "schema_unsupported",
        },
      },
    });
    return;
  }

  const { content, shown } = toAcpPromptContent(prompt);
  if (content.length === 0) {
    emit({
      type: "session.prompt_result",
      sessionId: session.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: {
        type: "failed",
        error: {
          message: "Antigravity requires a non-empty text prompt",
          code: "empty_prompt",
        },
      },
    });
    return;
  }

  // Active turn already running
  if (session.activeTurn !== null) {
    if (prompt.delivery === "steer") {
      const turn = session.activeTurn;

      emit({
        type: "session.prompt_result",
        sessionId: session.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: "steer",
          turnId: turn.turnId,
        },
      });

      publish(session, emit, {
        type: "user_message",
        id: `user:${prompt.clientMessageId}`,
        text: shown,
        clientMessageId: prompt.clientMessageId,
      });

      turn.messageIndex += 1;
      turn.thoughtIndex += 1;
      turn.currentMessageId = `agy:msg:${turn.turnId}:${turn.messageIndex}`;
      turn.currentMessageText = "";
      turn.currentThoughtId = `agy:thought:${turn.turnId}:${turn.thoughtIndex}`;
      turn.currentThoughtText = "";

      const {
        promise: steeringPromptPromise,
        resolve: resolveSteer,
        reject: rejectSteer,
      } = Promise.withResolvers<AcpPromptResult>();
      turn.activePromptPromise = steeringPromptPromise;

      void (async () => {
        try {
          const client = await ensureClient(session, emit);
          const actualPromptPromise = client.prompt(content);
          actualPromptPromise.then(resolveSteer, rejectSteer);
          await runTurnPrompt(session, turn, steeringPromptPromise, emit);
        } catch (err) {
          handleProcessExitOrCrash(
            session,
            err instanceof Error ? err : new Error(String(err)),
            emit,
          );
        }
      })();
      return;
    }

    // Busy
    emit({
      type: "session.prompt_result",
      sessionId: session.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: {
        type: "failed",
        error: {
          message: "Antigravity is busy running a turn",
          code: "busy",
        },
      },
    });
    return;
  }

  session.turnCounter += 1;
  const turnId = `turn-${session.turnCounter}-${randomUUID().slice(0, 8)}`;

  publish(session, emit, {
    type: "user_message",
    id: `user:${turnId}`,
    text: shown,
    clientMessageId: prompt.clientMessageId,
  });

  emit({
    type: "session.prompt_result",
    sessionId: session.sessionId,
    clientMessageId: prompt.clientMessageId,
    result: {
      type: "turn",
      turnId,
    },
  });

  emit({
    type: "session.turn",
    sessionId: session.sessionId,
    turnId,
    state: "started",
  });

  const {
    promise: promptPromise,
    resolve: resolvePrompt,
    reject: rejectPrompt,
  } = Promise.withResolvers<AcpPromptResult>();

  const activeTurn: AcpActiveTurn = {
    turnId,
    clientMessageId: prompt.clientMessageId,
    currentMessageId: `agy:msg:${turnId}:0`,
    currentMessageText: "",
    currentThoughtId: `agy:thought:${turnId}:0`,
    currentThoughtText: "",
    messageIndex: 0,
    thoughtIndex: 0,
    openTools: new Map(),
    activePromptPromise: promptPromise,
  };
  session.activeTurn = activeTurn;

  void (async () => {
    let client: AgyAcpClient;
    try {
      client = await ensureClient(session, emit);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      session.activeTurn = null;
      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId,
        state: "failed",
        error: {
          message: `Failed to launch Antigravity ACP client: ${errorMsg}`,
          code: "agy_launch_failed",
        },
      });
      return;
    }

    try {
      const actualPromptPromise = client.prompt(content);
      actualPromptPromise.then(resolvePrompt, rejectPrompt);
      await runTurnPrompt(session, activeTurn, promptPromise, emit);
    } catch (err) {
      handleProcessExitOrCrash(
        session,
        err instanceof Error ? err : new Error(String(err)),
        emit,
      );
    }
  })();
}

async function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  session: AcpSession,
  emit: Emit,
): Promise<void> {
  const { changes } = input;
  if (changes.mode !== undefined && changes.mode !== null) {
    session.selection.mode = changes.mode;
    if (session.client?.running) {
      await session.client.setMode(changes.mode);
    }
  }
  if (changes.model !== undefined && changes.model !== null) {
    session.selection.model = changes.model;
    if (session.client?.running) {
      await session.client.setConfigOption("model", changes.model);
    }
  }
  if (changes.thinkingOption !== undefined && changes.thinkingOption !== null) {
    session.selection.thinkingOption = changes.thinkingOption;
    if (session.client?.running) {
      await session.client.setConfigOption("thought_level", changes.thinkingOption);
    }
  }
  if (changes.settings) {
    session.settings = { ...session.settings, ...changes.settings };
  }

  emit({
    type: "session.config",
    sessionId: session.sessionId,
    config: configState(session),
  });
  emit({
    type: "request.completed",
    requestId: input.requestId,
  });
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: AcpConnectionState,
  emit: Emit,
  options: AcpConnectionOptions = {},
): Promise<void> {
  const config = input.config;
  const conversationId = persistenceField(input.persistence, "conversationId");
  const accountId = resolveAccountId(input.persistence, conversationId);
  const providerOpts = readProviderOptions(config);

  const rawTransport =
    options.transport ??
    (config.providerOptions as Record<string, unknown> | undefined)?.transport ??
    (config.providerOptions as Record<string, unknown> | undefined)?.acpTransport;

  const session = new AcpSession(
    input.sessionId,
    config,
    conversationId,
    accountId,
    rawTransport as AgyAcpClientTransport | (() => AgyAcpClientTransport) | undefined,
  );
  state.sessions.set(input.sessionId, session);

  const knownHistory = conversationId !== null && transcriptExists(conversationId);
  if (session.persist && conversationId !== null) {
    session.transcript = await TranscriptStore.load(conversationId);
  }

  emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    persistence: persistenceFor(session.conversationId, accountId),
    title: config.title,
    cwd: config.cwd,
  });

  emit({
    type: "session.config",
    sessionId: input.sessionId,
    config: configState(session),
  });

  const discovered = await discoverCommands(config.cwd, { binary: providerOpts.agyPath });
  const merged = mergeAvailableCommands([...discovered.commands]);
  session.commands = merged;
  emit({
    type: "session.commands",
    sessionId: input.sessionId,
    commands: merged,
  });

  if (conversationId !== null && !knownHistory) {
    emitNotice(
      session,
      emit,
      "history-unavailable",
      "info",
      "Earlier history is not shown",
      "This conversation already existed in Antigravity, so its earlier turns are not part of Paseo's timeline and are not replayed. Antigravity still has them, and the next reply continues the conversation.",
    );
  }

  if (input.history === "replay" && session.transcript) {
    for (const item of session.transcript.list()) {
      emit({
        type: "timeline.item",
        sessionId: session.sessionId,
        item,
      });
    }
  }

  emit({
    type: "session.ready",
    requestId: input.requestId,
    sessionId: input.sessionId,
  });
}

function validateAdmission(input: ProviderInput, state: AcpConnectionState): void {
  if (input.type === "session.open") {
    if (state.sessions.has(input.sessionId)) {
      throw new Error(`Session already exists: ${input.sessionId}`);
    }
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!("sessionId" in input)) {
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!state.sessions.has(input.sessionId)) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }
  requireProviderCapabilities(state.capabilities, input);
}

async function dispatch(
  input: ProviderInput,
  state: AcpConnectionState,
  emit: Emit,
  options: AcpConnectionOptions = {},
): Promise<void> {
  switch (input.type) {
    case "catalog":
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: await buildCatalog(readAccounts().active),
      });
      return;
    case "sessions":
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: listConversations({ cwd: input.cwd, query: input.query, limit: input.limit }),
      });
      return;
    case "session.open":
      await openSession(input, state, emit, options);
      return;
    case "session.prompt": {
      const session = requireAcpSession(state, input.sessionId);
      await promptSession(input, session, emit);
      return;
    }
    case "session.interrupt": {
      const session = requireAcpSession(state, input.sessionId);
      session.interrupting = true;
      session.client?.cancel();
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.configure": {
      const session = requireAcpSession(state, input.sessionId);
      await configureSession(input, session, emit);
      return;
    }
    case "session.can_stop_runtime": {
      const session = requireAcpSession(state, input.sessionId);
      const canStop = session.activeTurn === null;
      emit({
        type: "session.can_stop_runtime",
        requestId: input.requestId,
        sessionId: input.sessionId,
        canStop,
      });
      return;
    }
    case "session.permission": {
      // TODO(acp-3b): Permission cards
      emit({
        type: "session.permission_resolved",
        sessionId: input.sessionId,
        permissionId: input.permissionId,
      });
      return;
    }
    case "session.close": {
      const session = requireAcpSession(state, input.sessionId);
      session.closing = true;
      if (session.transcript) {
        await session.transcript.flush();
      }
      if (session.client) {
        await session.client.close();
        session.client = null;
      }
      state.sessions.delete(input.sessionId);
      emit({ type: "session.closed", sessionId: input.sessionId });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    default:
      throw new Error(`Unsupported provider input: ${(input as { type: string }).type}`);
  }
}

/**
 * Creates an ACP-backed Paseo provider connection.
 */
export function createAcpConnection(
  capabilities: readonly ProviderCapability[],
  options: AcpConnectionOptions = {},
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const state: AcpConnectionState = { capabilities, sessions: new Map() };
  let closed = false;

  const emit: Emit = (event) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Antigravity provider connection is closed");
      validateAdmission(input, state);
      await dispatch(input, state, emit, options);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const closingSessions: Promise<void>[] = [];
      for (const session of state.sessions.values()) {
        session.closing = true;
        if (session.transcript) {
          closingSessions.push(session.transcript.flush());
        }
        if (session.client) {
          closingSessions.push(session.client.close());
          session.client = null;
        }
      }
      state.sessions.clear();
      listeners.clear();
      await Promise.all(closingSessions);
    },
  };
}
