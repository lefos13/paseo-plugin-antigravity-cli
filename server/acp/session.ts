import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { conversationTranscriptPath, BACKGROUND_LAUNCH } from "../backfill";
import { toolFailureError } from "../protocol";
import { readToolPermission } from "../agysettings";
import { buildCatalog, DEFAULT_MODE_ID, resolveThinking } from "../catalog";
import { discoverCommands, SYSTEM_COMMANDS, type AgyCommand } from "../commands";
import { PASEO_MCP_PREFIX, type McpServerConfig } from "../mcp";
import { pluginDataDir, unsafePathChars } from "../plugindata";
import { listConversations } from "../sessions";
import {
  decodeArgs,
  parseCreatedSubagents,
  parseTranscriptLines,
  SubagentTranscript,
  type ChildAction,
  type ChildRender,
  type CreatedSubagent,
  type SubagentTranscriptConfig,
  type TranscriptEntry,
} from "../subagents";
import { mapToolDetail } from "../tools";
import { TranscriptStore, transcriptExists } from "../transcript";
import {
  ACP_CAPABILITIES,
  approvalPolicy,
  childSessionId,
  childTurnId,
  configState,
  emitNotice,
  isSettingOn,
  objectRootSchema,
  persistenceField,
  persistenceFor,
  readProviderOptions,
  renderPart,
  resolveAccountId,
  resolveChildCwd,
  turnFailure,
  IMPLEMENT_MODE_ID,
  IMPLEMENT_PLAN_TEXT,
  PLAN_COMMAND,
  PLAN_MODE_ID,
  type ConfigStateSession,
} from "../provider";
import {
  questionRequest,
  questionRow,
  readAnswers,
  readQuestions,
  NO_ANSWER,
  type AgyQuestion,
} from "../questions";
import {
  AgyAcpClient,
  type AgyAcpClientConfig,
  type AgyAcpClientOptions,
  type AgyAcpClientTransport,
} from "./client";
import type {
  AcpAvailableCommandsUpdate,
  AcpCurrentModeUpdate,
  AcpElicitationParams,
  AcpElicitationResult,
  AcpMessageChunkUpdate,
  AcpPermissionOption,
  AcpPromptContent,
  AcpPromptResult,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
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
    const isPlan = prompt.input.name === PLAN_COMMAND;
    const text = args.length > 0 ? `/${prompt.input.name} ${args}` : `/${prompt.input.name}`;
    if (isPlan) {
      return {
        content: [{ type: "text", text: args.length > 0 ? args : "plan" }],
        shown: text,
      };
    }
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

export interface PendingPermission {
  readonly id: string;
  readonly toolCallId: string;
  readonly options: AcpPermissionOption[];
  readonly resolve: (result: AcpRequestPermissionResult) => void;
}

export interface PendingQuestion {
  readonly id: string;
  readonly toolCallId: string;
  readonly questions: readonly AgyQuestion[];
  readonly schema?: Record<string, unknown>;
  readonly resolve: (result: AcpElicitationResult) => void;
}

export interface PendingPlan {
  readonly id: string;
  readonly text: string;
  readonly previousMode?: string;
}

export interface AcpActiveTurn {
  readonly turnId: string;
  readonly clientMessageId?: string;
  currentMessageId: string;
  currentMessageText: string;
  currentThoughtId: string;
  currentThoughtText: string;
  messageIndex: number;
  thoughtIndex: number;
  readonly openTools: Map<string, ProviderToolCallItem>;
  activePromptPromise: Promise<AcpPromptResult>;
  isPlan?: boolean;
  previousMode?: string;
  latestPlan?: { text: string };
}

export interface AcpSubagentFollow {
  readonly rowId: string;
  childConversationId: string;
  childId: string;
  cwd: string;
  role?: string;
  typeName?: string;
  prompt?: string;
  log: string;
  actions: ChildAction[];
  status: "running" | "completed" | "failed";
  opened: boolean;
  done: boolean;
  autoNotified?: boolean;
  transcript?: SubagentTranscript;
  store: TranscriptStore | null;
}

export interface AutoContinueItem {
  type: "subagent" | "command";
  title: string;
  body: string;
}

export interface TrackedBackgroundCommand {
  callId: string;
  rowId: string;
  name: string;
  command: string;
  tool: ProviderToolCallItem;
  afterStepIndex?: number;
}

export interface DiscoveredChild {
  readonly conversationId: string;
  readonly logUri: string;
  readonly workspaceUris?: readonly string[];
}

export interface OneShotArgs {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface OneShotResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export type OneShotRunner = (args: OneShotArgs) => Promise<OneShotResult>;

export async function defaultRunOneShot(args: OneShotArgs): Promise<OneShotResult> {
  const { promise, resolve } = Promise.withResolvers<OneShotResult>();
  execFile(
    args.binary,
    [...args.args],
    { cwd: args.cwd, env: { ...process.env, ...args.env } as NodeJS.ProcessEnv, maxBuffer: 10 * 1024 * 1024 },
    (error, stdout, stderr) => {
      resolve({
        stdout: typeof stdout === "string" ? stdout : stdout ? String(stdout) : "",
        stderr: typeof stderr === "string" ? stderr : stderr ? String(stderr) : "",
        code: error ? (((error as any).code as number) ?? 1) : 0,
      });
    },
  );
  return promise;
}

export function buildOneShotAgyArgs(options: {
  promptText: string;
  conversationId: string;
  schemaPath: string;
  model?: string;
  thinkingOption?: string;
  mode?: string;
  accountId: string;
  skipPermissions: boolean;
  extraArgs?: readonly string[];
}): string[] {
  const thinking = resolveThinking(options.model, options.thinkingOption, options.accountId);
  const args: string[] = [
    "-p",
    options.promptText,
    "--conversation",
    options.conversationId,
    "--output-format",
    "json",
    "--json-schema",
    options.schemaPath,
    "--disable-slash-commands",
  ];
  if (thinking.slug) {
    args.push("--model", thinking.slug);
  }
  if (options.mode && options.mode !== "default" && options.mode !== PLAN_MODE_ID) {
    args.push("--mode", options.mode);
  }
  if (options.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  return args;
}

export function toAcpMcpServers(
  mcpServers: Record<string, McpServerConfig>,
): unknown[] {
  const result: unknown[] = [];
  for (const [key, server] of Object.entries(mcpServers)) {
    const name = `${PASEO_MCP_PREFIX}${key}`;
    if (server.type === "stdio") {
      result.push({
        name,
        command: server.command,
        args: server.args ? [...server.args] : [],
        env: server.env
          ? Object.entries(server.env).map(([k, value]) => ({ name: k, value }))
          : [],
      });
    } else if (server.type === "http") {
      result.push({
        type: "http",
        name,
        url: server.url,
        headers: server.headers
          ? Object.entries(server.headers).map(([k, value]) => ({ name: k, value }))
          : [],
      });
    } else if (server.type === "sse") {
      result.push({
        type: "sse",
        name,
        url: server.url,
        headers: server.headers
          ? Object.entries(server.headers).map(([k, value]) => ({ name: k, value }))
          : [],
      });
    }
  }
  return result;
}

export function findNewChildren(
  transcriptText: string,
  parentConversationId: string,
  alreadyFollowed: ReadonlySet<string>,
  geminiRoot: string,
): DiscoveredChild[] {
  const result: DiscoveredChild[] = [];
  const seen = new Set<string>();

  const lines = transcriptText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (
      trimmed.includes("conversationId") ||
      trimmed.includes("logAbsoluteUri") ||
      trimmed.includes("Created the following subagents")
    ) {
      try {
        const step = JSON.parse(trimmed);
        if (step && typeof step === "object") {
          const content = typeof step.content === "string" ? step.content : "";
          if (content.length > 0) {
            const created = parseCreatedSubagents(content);
            for (const sub of created) {
              if (
                sub.conversationId &&
                sub.conversationId !== parentConversationId &&
                !alreadyFollowed.has(sub.conversationId) &&
                !seen.has(sub.conversationId)
              ) {
                seen.add(sub.conversationId);
                const logUri =
                  sub.logUri ??
                  pathToFileURL(conversationTranscriptPath(geminiRoot, sub.conversationId)).href;
                result.push({
                  conversationId: sub.conversationId,
                  logUri,
                  workspaceUris: sub.workspaceUris ? [...sub.workspaceUris] : undefined,
                });
              }
            }
          }
        }
      } catch {
        // Not a single JSON line
      }

      const created = parseCreatedSubagents(trimmed);
      for (const sub of created) {
        if (
          sub.conversationId &&
          sub.conversationId !== parentConversationId &&
          !alreadyFollowed.has(sub.conversationId) &&
          !seen.has(sub.conversationId)
        ) {
          seen.add(sub.conversationId);
          const logUri =
            sub.logUri ??
            pathToFileURL(conversationTranscriptPath(geminiRoot, sub.conversationId)).href;
          result.push({
            conversationId: sub.conversationId,
            logUri,
            workspaceUris: sub.workspaceUris ? [...sub.workspaceUris] : undefined,
          });
        }
      }
    }

    if (trimmed.includes("SYSTEM_MESSAGE") && trimmed.includes("sender=")) {
      const match = /sender=([0-9a-fA-F-]{36})/.exec(trimmed);
      if (
        match &&
        match[1] &&
        match[1] !== parentConversationId &&
        !alreadyFollowed.has(match[1]) &&
        !seen.has(match[1])
      ) {
        const childId = match[1];
        seen.add(childId);
        const logPath = conversationTranscriptPath(geminiRoot, childId);
        result.push({
          conversationId: childId,
          logUri: pathToFileURL(logPath).href,
        });
      }
    }
  }

  const regex = /(?:file:\/\/)?([^\s"'`]+\/brain\/([0-9a-fA-F-]{36})\/\.system_generated\/logs\/transcript\.jsonl)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(transcriptText)) !== null) {
    const rawPath = match[1];
    const childId = match[2];
    if (childId !== parentConversationId && !alreadyFollowed.has(childId) && !seen.has(childId)) {
      seen.add(childId);
      const logUri = rawPath.startsWith("file://") ? rawPath : pathToFileURL(rawPath).href;
      result.push({
        conversationId: childId,
        logUri,
      });
    }
  }

  return result;
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

  pendingPlan: PendingPlan | null = null;
  readonly pendingQuestions = new Map<string, PendingQuestion>();
  readonly pendingPermissions = new Map<string, PendingPermission>();
  lastAskQuestionToolCall?: AcpToolCallUpdate;

  // Optional transport and hooks for scripted testing
  injectedTransport?: AgyAcpClientTransport | (() => AgyAcpClientTransport);
  runOneShot?: OneShotRunner;
  readTranscriptFile?: (path: string) => Promise<string> | string;
  statTranscriptFile?: (path: string) => Promise<{ size: number; mtimeMs: number }>;

  readonly childCapabilities: readonly ProviderCapability[];
  readonly subagentFollows = new Map<string, AcpSubagentFollow>();
  readonly followedChildren = new Set<string>();
  readonly childSessions = new Set<string>();

  consecutiveAutoContinuations = 0;
  pendingAutoItems: AutoContinueItem[] = [];
  autoContinueTimer: NodeJS.Timeout | null = null;
  readonly autoContinueDelayMs: number;

  readonly backgroundCommands = new Map<string, TrackedBackgroundCommand>();
  backgroundWatcherTimer: NodeJS.Timeout | null = null;
  readonly backgroundPollMs: number;

  readonly parentTranscriptWatcherTimers = new Set<NodeJS.Timeout>();

  constructor(
    sessionId: string,
    config: ProviderSessionConfig,
    conversationId: string | null,
    accountId: string,
    injectedTransport?: AgyAcpClientTransport | (() => AgyAcpClientTransport),
    runOneShot?: OneShotRunner,
    readTranscriptFile?: (path: string) => Promise<string> | string,
    statTranscriptFile?: (path: string) => Promise<{ size: number; mtimeMs: number }>,
    childCapabilities: readonly ProviderCapability[] = [],
    autoContinueDelayMs?: number,
    backgroundPollMs?: number,
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
    this.runOneShot = runOneShot;
    this.readTranscriptFile = readTranscriptFile;
    this.statTranscriptFile = statTranscriptFile;
    this.childCapabilities = childCapabilities;
    this.autoContinueDelayMs = autoContinueDelayMs ?? 2000;
    this.backgroundPollMs = backgroundPollMs ?? 200;
  }
}

interface AcpConnectionState {
  capabilities: readonly ProviderCapability[];
  sessions: Map<string, AcpSession>;
}

export interface AcpConnectionOptions {
  clientFactory?: (config: AgyAcpClientConfig, options: AgyAcpClientOptions) => AgyAcpClient;
  transport?: AgyAcpClientTransport | (() => AgyAcpClientTransport);
  runOneShot?: OneShotRunner;
  readTranscriptFile?: (path: string) => Promise<string> | string;
  statTranscriptFile?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  autoContinueDelayMs?: number;
  backgroundPollMs?: number;
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

function cancelPendingPermissions(session: AcpSession, emit: Emit): void {
  for (const [id, pending] of session.pendingPermissions.entries()) {
    pending.resolve({ outcome: { outcome: "cancelled" } });
    emit({
      type: "session.permission_resolved",
      sessionId: session.sessionId,
      permissionId: id,
    });
  }
  session.pendingPermissions.clear();
}

function cancelPendingQuestions(session: AcpSession, emit: Emit): void {
  for (const [id, pending] of session.pendingQuestions.entries()) {
    pending.resolve({ action: "cancel" });
    publish(
      session,
      emit,
      questionRow(pending.toolCallId, pending.questions, { kind: "dismissed" }),
    );
    emit({
      type: "session.permission_resolved",
      sessionId: session.sessionId,
      permissionId: id,
    });
  }
  session.pendingQuestions.clear();
}

function resolvePendingPlan(session: AcpSession, emit: Emit): void {
  const plan = session.pendingPlan;
  if (!plan) return;
  session.pendingPlan = null;
  emit({
    type: "session.permission_resolved",
    sessionId: session.sessionId,
    permissionId: plan.id,
  });
}

function offerPlan(
  session: AcpSession,
  emit: Emit,
  turn: AcpActiveTurn,
  text: string,
): void {
  if (text.trim().length === 0) return;
  resolvePendingPlan(session, emit);
  const id = `plan:${turn.turnId}`;
  session.pendingPlan = { id, text, previousMode: turn.previousMode };
  emit({
    type: "session.permission",
    sessionId: session.sessionId,
    request: {
      id,
      name: "plan",
      kind: "plan",
      title: "Implement this plan?",
      detail: { type: "plan", text },
      actions: [
        {
          id: "implement",
          label: "Implement",
          behavior: "allow",
          variant: "primary",
          intent: "implement",
        },
        {
          id: "dismiss",
          label: "Keep planning",
          behavior: "deny",
          variant: "secondary",
          intent: "dismiss",
        },
      ],
    },
  });
}

function extractPlanText(toolUpdate: AcpToolCallUpdate): string | null {
  if (toolUpdate.name !== "write_file") return null;

  const rawArgs =
    typeof toolUpdate.args === "object" && toolUpdate.args !== null && !Array.isArray(toolUpdate.args)
      ? (toolUpdate.args as Record<string, unknown>)
      : typeof toolUpdate.rawInput === "object" && toolUpdate.rawInput !== null && !Array.isArray(toolUpdate.rawInput)
        ? (toolUpdate.rawInput as Record<string, unknown>)
        : undefined;

  if (!rawArgs) return null;

  const metadata =
    typeof rawArgs.ArtifactMetadata === "object" && rawArgs.ArtifactMetadata !== null
      ? (rawArgs.ArtifactMetadata as Record<string, unknown>)
      : undefined;

  if (metadata?.RequestFeedback !== true) return null;

  const content =
    typeof rawArgs.Content === "string"
      ? rawArgs.Content
      : typeof rawArgs.content === "string"
        ? rawArgs.content
        : "";

  return content.length > 0 ? content : null;
}

function parseQuestionsFromSchema(schema: Record<string, unknown>): AgyQuestion[] {
  const questions: AgyQuestion[] = [];
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return [];

  for (const [key, prop] of Object.entries(props)) {
    if (key.endsWith("_other")) continue;
    const qText =
      typeof prop.title === "string"
        ? prop.title
        : typeof prop.description === "string"
          ? prop.description
          : key;
    const isMulti = prop.type === "array";
    const options: string[] = [];
    const choices = Array.isArray(prop.oneOf)
      ? prop.oneOf
      : Array.isArray(prop.anyOf)
        ? prop.anyOf
        : typeof prop.items === "object" && prop.items !== null
          ? (Array.isArray((prop.items as any).oneOf)
              ? (prop.items as any).oneOf
              : Array.isArray((prop.items as any).anyOf)
                ? (prop.items as any).anyOf
                : [])
          : [];

    for (const choice of choices) {
      if (choice && typeof choice === "object") {
        const title =
          typeof choice.title === "string"
            ? choice.title
            : typeof choice.name === "string"
              ? choice.name
              : typeof choice.const === "string"
                ? choice.const
                : "";
        if (title) options.push(title);
      }
    }

    questions.push({
      question: qText,
      options,
      multiSelect: isMulti,
    });
  }
  return questions;
}

function findChoiceMatch(choices: any[], text: string): any {
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const norm = (s: string) =>
    s
      .replace(/^\(Recommended\)\s*/i, "")
      .trim()
      .toLowerCase();
  const target = norm(text);

  for (const c of choices) {
    if (!c || typeof c !== "object") continue;
    const title = typeof c.title === "string" ? c.title : typeof c.name === "string" ? c.name : "";
    if (norm(title) === target || title.trim().toLowerCase() === text.trim().toLowerCase()) {
      return c;
    }
  }

  for (const c of choices) {
    if (!c || typeof c !== "object") continue;
    if (c.const !== undefined && String(c.const).toLowerCase() === target) {
      return c;
    }
    if (c.value !== undefined && String(c.value).toLowerCase() === target) {
      return c;
    }
  }

  return null;
}

function publishSubagentRow(
  session: AcpSession,
  emit: Emit,
  follow: AcpSubagentFollow,
): void {
  const callId = follow.rowId.replace(/^tool:/, "");
  const type = follow.role ?? follow.typeName;
  const item: ProviderTimelineItem = {
    type: "tool_call",
    id: follow.rowId,
    callId,
    name: "invoke_subagent",
    detail: {
      type: "sub_agent",
      ...(follow.typeName !== undefined ? { subAgentType: follow.typeName } : {}),
      ...(type !== undefined ? { description: type } : {}),
      ...(follow.childId ? { childSessionId: follow.childId } : {}),
      log: follow.log,
      ...(follow.actions.length > 0 ? { actions: follow.actions } : {}),
    },
    metadata: {
      subagent: {
        ...(follow.childConversationId ? { conversationId: follow.childConversationId } : {}),
        ...(follow.typeName !== undefined ? { typeName: follow.typeName } : {}),
        ...(follow.role !== undefined ? { role: follow.role } : {}),
        ...(follow.prompt !== undefined ? { prompt: follow.prompt } : {}),
        ...(follow.done ? { done: true } : {}),
      },
    },
    status: follow.status,
    error: null,
  };

  if (session.activeTurn) {
    session.activeTurn.openTools.set(callId, item as ProviderToolCallItem);
  }
  publish(session, emit, item);
}

function handleChildRender(
  session: AcpSession,
  emit: Emit,
  follow: AcpSubagentFollow,
  render: ChildRender,
  changed: readonly ProviderTimelineItem[],
): void {
  if (session.closing) return;

  if (!follow.opened) {
    if (render.items.length === 0) return;
    follow.opened = true;
    session.childSessions.add(follow.childId);
    emit({
      type: "session.opened",
      sessionId: follow.childId,
      parentSessionId: session.sessionId,
      toolCallId: follow.rowId,
      capabilities: session.childCapabilities,
      restoration: "parent",
      title: follow.role ?? follow.typeName ?? "Subagent",
      description: (follow.prompt ?? "").slice(0, 100),
      cwd: follow.cwd,
    });
    emit({ type: "session.ready", sessionId: follow.childId });
    emit({
      type: "session.turn",
      sessionId: follow.childId,
      turnId: childTurnId(follow.childConversationId),
      state: "started",
    });
  }

  for (const item of changed) {
    if (follow.store) follow.store.upsert(item);
    emit({ type: "timeline.item", sessionId: follow.childId, item });
  }

  const finished = render.done;
  follow.done = finished;
  if (render.report.length > 0) follow.log = render.report;
  if (render.actions.length > 0) follow.actions = [...render.actions];
  if (finished && follow.status === "running") follow.status = "completed";

  publishSubagentRow(session, emit, follow);

  if (finished) {
    emit({
      type: "session.turn",
      sessionId: follow.childId,
      turnId: childTurnId(follow.childConversationId),
      state: "completed",
    });
    emit({
      type: "session.closed",
      sessionId: follow.childId,
    });
    session.childSessions.delete(follow.childId);
    follow.transcript?.stop();
    void follow.store?.flush();

    if (!follow.autoNotified) {
      follow.autoNotified = true;
      const role = follow.role ?? follow.typeName ?? "Subagent";
      const finalReply = (render.report || follow.log || "").slice(0, 4000);
      scheduleAutoContinue(session, emit, {
        type: "subagent",
        title: `Subagent "${role}" finished. Its final reply:`,
        body: finalReply,
      });
    }
  }
}

async function attachChildToFollow(
  session: AcpSession,
  emit: Emit,
  follow: AcpSubagentFollow,
  child: DiscoveredChild,
): Promise<void> {
  follow.childConversationId = child.conversationId;
  follow.childId = childSessionId(session.sessionId, child.conversationId);
  follow.cwd = resolveChildCwd(session.config.cwd, child.workspaceUris);

  if (session.persist) {
    try {
      follow.store = await TranscriptStore.load(child.conversationId);
    } catch {
      // Best-effort
    }
  }

  publishSubagentRow(session, emit, follow);

  const transcriptConfig: SubagentTranscriptConfig = {
    logUri: child.logUri,
    childConversationId: child.conversationId,
    parentConversationId: session.conversationId!,
    cwd: follow.cwd,
    readFile: session.readTranscriptFile ? (p) => Promise.resolve(session.readTranscriptFile!(p)) : undefined,
    stat: session.statTranscriptFile ? (p) => Promise.resolve(session.statTranscriptFile!(p)) : undefined,
  };

  const follower = new SubagentTranscript(transcriptConfig, {
    onRender: (render, changed) => handleChildRender(session, emit, follow, render, changed),
    onDegrade: (reason) => {
      console.error(`[antigravity] not following subagent ${child.conversationId}: ${reason}`);
    },
    onLost: (reason) => {
      console.error(`[antigravity] stopped following subagent ${child.conversationId}: ${reason}`);
      if (follow.opened && !follow.done) {
        emit({
          type: "session.turn",
          sessionId: follow.childId,
          turnId: childTurnId(child.conversationId),
          state: "canceled",
          error: { message: reason },
        });
        emit({
          type: "session.closed",
          sessionId: follow.childId,
          error: { message: reason },
        });
        session.childSessions.delete(follow.childId);
      }
    },
  });

  follow.transcript = follower;
  follower.start();
}

function startParentTranscriptWatcher(
  session: AcpSession,
  emit: Emit,
  follow: AcpSubagentFollow,
  _toolCallId: string,
): void {
  if (follow.childConversationId) return;

  const parentConversationId = session.conversationId;
  if (!parentConversationId) return;

  const geminiRoot = accountGeminiRoot(session.accountId);
  const parentTranscriptPath = conversationTranscriptPath(geminiRoot, parentConversationId);

  const startedAt = Date.now();
  const TIMEOUT_MS = 30_000;
  const POLL_MS = session.backgroundPollMs ?? 200;

  const check = async (): Promise<boolean> => {
    if (session.closing || follow.childConversationId) return true;

    try {
      let content = "";
      if (session.readTranscriptFile) {
        content = await session.readTranscriptFile(parentTranscriptPath);
      } else if (existsSync(parentTranscriptPath)) {
        content = await readFile(parentTranscriptPath, "utf8");
      }

      if (content.length > 0) {
        const found = findNewChildren(content, parentConversationId, session.followedChildren, geminiRoot);
        if (found.length > 0) {
          const child = found[0];
          session.followedChildren.add(child.conversationId);
          await attachChildToFollow(session, emit, follow, child);
          return true;
        }
      }
    } catch {
      // Best-effort
    }
    return false;
  };

  const poll = async () => {
    const done = await check();
    if (done) return;

    if (Date.now() - startedAt < TIMEOUT_MS && !session.closing && !follow.childConversationId) {
      const timer = setTimeout(async () => {
        session.parentTranscriptWatcherTimers.delete(timer);
        await poll();
      }, POLL_MS);
      timer.unref();
      session.parentTranscriptWatcherTimers.add(timer);
    }
  };

  void poll();
}

function handleAcpSubagentToolUpdate(
  session: AcpSession,
  toolUpdate: AcpToolCallUpdate,
  emit: Emit,
): void {
  const callId = toolUpdate.toolCallId;
  const rowId = `tool:${callId}`;

  const rawArgs =
    typeof toolUpdate.args === "object" && toolUpdate.args !== null && !Array.isArray(toolUpdate.args)
      ? (toolUpdate.args as Record<string, unknown>)
      : typeof toolUpdate.rawInput === "object" && toolUpdate.rawInput !== null && !Array.isArray(toolUpdate.rawInput)
        ? (toolUpdate.rawInput as Record<string, unknown>)
        : undefined;

  let follow = session.subagentFollows.get(rowId);
  if (!follow) {
    const role =
      typeof rawArgs?.Role === "string"
        ? rawArgs.Role
        : typeof rawArgs?.role === "string"
          ? rawArgs.role
          : undefined;
    const typeName =
      typeof rawArgs?.TypeName === "string"
        ? rawArgs.TypeName
        : typeof rawArgs?.typeName === "string"
          ? rawArgs.typeName
          : undefined;
    const prompt =
      typeof rawArgs?.Prompt === "string"
        ? rawArgs.Prompt
        : typeof rawArgs?.prompt === "string"
          ? rawArgs.prompt
          : undefined;

    follow = {
      rowId,
      childConversationId: "",
      childId: "",
      cwd: session.config.cwd,
      role,
      typeName,
      prompt,
      log: prompt ?? "",
      actions: [],
      status: "running",
      opened: false,
      done: false,
      store: null,
    };
    session.subagentFollows.set(rowId, follow);

    publishSubagentRow(session, emit, follow);
    startParentTranscriptWatcher(session, emit, follow, callId);
  } else {
    if (rawArgs) {
      if (!follow.role && typeof rawArgs.Role === "string") follow.role = rawArgs.Role;
      if (!follow.typeName && typeof rawArgs.TypeName === "string") follow.typeName = rawArgs.TypeName;
      if (!follow.prompt && typeof rawArgs.Prompt === "string") follow.prompt = rawArgs.Prompt;
    }
    if (toolUpdate.status === "failed") {
      follow.status = "failed";
      publishSubagentRow(session, emit, follow);
    }
  }
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
      const toolUpdate = update as AcpToolCallUpdate;
      const callId = toolUpdate.toolCallId;
      const rowId = `tool:${callId}`;

      const previous = turn?.openTools.get(callId);
      const isSubagent =
        toolUpdate.name === "invoke_subagent" ||
        previous?.name === "invoke_subagent" ||
        session.subagentFollows.has(rowId);

      if (isSubagent) {
        handleAcpSubagentToolUpdate(session, toolUpdate, emit);
        return;
      }

      if (!turn) {
        return;
      }

      // Plan detection: write_file with ArtifactMetadata.RequestFeedback === true
      const planText = extractPlanText(toolUpdate);
      if (planText) {
        turn.latestPlan = { text: planText };
      }

      // Special handling for ask_question: save tool call and do not emit plain tool row
      if (toolUpdate.name === "ask_question") {
        session.lastAskQuestionToolCall = toolUpdate;
        return;
      }

      const item = resolveToolItem(toolUpdate, previous, session.config.cwd);

      if (item.status === "running") {
        turn.openTools.set(callId, item);
      } else {
        turn.openTools.delete(callId);
      }

      publish(session, emit, item);

      // If write_file plan tool call completed in plan mode, offer plan card
      if (
        (turn.isPlan || session.selection.mode === PLAN_MODE_ID) &&
        toolUpdate.status === "completed" &&
        turn.latestPlan &&
        !session.pendingPlan
      ) {
        offerPlan(session, emit, turn, turn.latestPlan.text);
      }
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
  cancelPendingPermissions(session, emit);
  cancelPendingQuestions(session, emit);
  resolvePendingPlan(session, emit);

  const turn = session.activeTurn;
  const client = session.client;
  session.client = null;

  if (turn) {
    session.activeTurn = null;

    for (const tool of turn.openTools.values()) {
      if (tool.name === "invoke_subagent") {
        const follow = session.subagentFollows.get(tool.id);
        if (follow && !follow.done) continue;
      }
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
      const skipPermissions = approvalPolicy(session) === "skip";

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
          onRequestPermission: async (params) => {
            if (session.closing || session.interrupting) {
              return { outcome: { outcome: "cancelled" } };
            }

            // Skip policy auto-allows without emitting a card
            const skip = approvalPolicy(session) === "skip";
            if (skip) {
              const allowOpt =
                params.options?.find((o) => o.kind === "allow_once") ??
                params.options?.find((o) => o.kind?.startsWith("allow")) ??
                params.options?.find((o) => o.optionId === "allow");
              if (allowOpt) {
                return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
              }
              return { outcome: { outcome: "cancelled" } };
            }

            const toolCall = params.toolCall as AcpToolCallUpdate | undefined;
            const toolCallId = toolCall?.toolCallId ?? `call_${randomUUID().slice(0, 8)}`;
            const permissionId = toolCallId;
            const options = params.options ?? [];

            const { promise, resolve } = Promise.withResolvers<AcpRequestPermissionResult>();
            const pending: PendingPermission = {
              id: permissionId,
              toolCallId,
              options,
              resolve,
            };
            session.pendingPermissions.set(permissionId, pending);

            const detail = toolCall ? mapAcpToolDetail(toolCall, session.config.cwd) : undefined;
            emit({
              type: "session.permission",
              sessionId: session.sessionId,
              request: {
                id: permissionId,
                name: toolCall?.name ?? toolCall?.title ?? "tool",
                kind: "tool",
                title: toolCall?.title,
                detail,
                actions: options.map((opt) => ({
                  id: opt.optionId,
                  label: opt.name ?? (opt.kind?.startsWith("allow") ? "Allow" : "Deny"),
                  behavior: opt.kind?.startsWith("allow") ? "allow" : "deny",
                })),
              },
            });

            return promise;
          },
          onElicitation: async (params) => {
            if (session.closing || session.interrupting) {
              return { action: "cancel" };
            }

            const toolCallId = params.toolCallId ?? `call_${randomUUID().slice(0, 8)}`;
            let questions: AgyQuestion[] = [];

            if (
              session.lastAskQuestionToolCall &&
              (!params.toolCallId || session.lastAskQuestionToolCall.toolCallId === params.toolCallId)
            ) {
              const rawArgs =
                typeof session.lastAskQuestionToolCall.args === "object" && session.lastAskQuestionToolCall.args !== null
                  ? (session.lastAskQuestionToolCall.args as Record<string, unknown>)
                  : typeof session.lastAskQuestionToolCall.rawInput === "object" && session.lastAskQuestionToolCall.rawInput !== null
                    ? (session.lastAskQuestionToolCall.rawInput as Record<string, unknown>)
                    : undefined;
              questions = readQuestions(rawArgs?.questions);
            }

            if (questions.length === 0 && params.requestedSchema?.properties) {
              questions = parseQuestionsFromSchema(params.requestedSchema);
            }

            const id = `question:${toolCallId}`;
            const request = questionRequest(id, questions);

            const { promise, resolve } = Promise.withResolvers<AcpElicitationResult>();
            const pending: PendingQuestion = {
              id,
              toolCallId,
              questions,
              schema: params.requestedSchema,
              resolve,
            };
            session.pendingQuestions.set(id, pending);
            session.pendingQuestions.set(toolCallId, pending);

            publish(session, emit, questionRow(toolCallId, questions, { kind: "pending" }));
            emit({
              type: "session.permission",
              sessionId: session.sessionId,
              request,
            });

            return promise;
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

      const shareMcp = isSettingOn(session.settings.shareMcp);
      const mcpServers = shareMcp ? toAcpMcpServers(session.config.mcpServers ?? {}) : [];

      if (session.conversationId) {
        await client.resumeSession({
          sessionId: session.conversationId,
          cwd: session.config.cwd,
          mcpServers,
          systemPromptAppend: session.config.systemPrompt,
        });
      } else {
        const res = await client.newSession({
          cwd: session.config.cwd,
          mcpServers,
          systemPromptAppend: session.config.systemPrompt,
        });
        session.conversationId = res.sessionId;
        if (session.persist) {
          session.transcript = new TranscriptStore(session.conversationId);
        }
        emit({
          type: "session.persistence",
          sessionId: session.sessionId,
          persistence: persistenceFor(session.conversationId, session.accountId, "acp"),
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
      cancelPendingPermissions(session, emit);
      cancelPendingQuestions(session, emit);
      resolvePendingPlan(session, emit);
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
        if (tool.name === "invoke_subagent") {
          const follow = session.subagentFollows.get(tool.id);
          if (follow && !follow.done) {
            continue;
          }
        }
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

        const publishedTool: ProviderToolCallItem = {
          ...tool,
          detail,
          status: "completed",
          error: null,
        };
        publish(session, emit, publishedTool);

        if (tool.name !== "invoke_subagent") {
          const command = detail.type === "shell" ? detail.command : tool.name;
          session.backgroundCommands.set(tool.id, {
            callId: tool.callId,
            rowId: tool.id,
            name: tool.name,
            command,
            tool: publishedTool,
          });
        }
      }
      turn.openTools.clear();

      if (session.backgroundCommands.size > 0) {
        startBackgroundCommandWatcher(session, emit);
      }

      // If plan mode turn finished with a plan, offer it if not already offered
      if (
        (turn.isPlan || session.selection.mode === PLAN_MODE_ID) &&
        turn.latestPlan &&
        !session.pendingPlan
      ) {
        offerPlan(session, emit, turn, turn.latestPlan.text);
      }

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

export function formatAutoContinueMessage(items: readonly AutoContinueItem[]): string {
  const parts = items.map((item) => `${item.title}\n\n${item.body}`);
  return `[Automatic message from Paseo] ${parts.join("\n\n")}`;
}

export function findBackgroundCommandCompletion(
  entries: readonly TranscriptEntry[],
  tracked: TrackedBackgroundCommand,
): { output: string; status: "completed" | "failed"; error: JsonValue } | null {
  const sorted = [...entries].sort((a, b) => a.stepIndex - b.stepIndex);

  let matchedCall: { stepIndex: number; callIndex: number } | null = null;
  for (const entry of sorted) {
    if (entry.type !== "PLANNER_RESPONSE") continue;
    for (let index = 0; index < entry.toolCalls.length; index += 1) {
      const call = entry.toolCalls[index];
      const decoded = decodeArgs(call.args);
      const command =
        typeof decoded.parameters.CommandLine === "string"
          ? decoded.parameters.CommandLine
          : typeof decoded.parameters.command === "string"
            ? decoded.parameters.command
            : "";
      if (
        call.name === tracked.name &&
        (command === tracked.command || !tracked.command || command.trim() === tracked.command.trim())
      ) {
        matchedCall = { stepIndex: entry.stepIndex, callIndex: index };
      }
    }
  }

  if (matchedCall === null) return null;

  const { stepIndex: callStepIndex, callIndex } = matchedCall;
  const resultStepIndex = callStepIndex + 1 + callIndex;
  const resultEntry = sorted.find((e) => e.stepIndex === resultStepIndex);
  if (!resultEntry) return null;

  const content = resultEntry.content ?? "";
  const launchMatch = BACKGROUND_LAUNCH.exec(content);

  if (launchMatch) {
    const taskId = launchMatch[1];
    for (const entry of sorted) {
      if (entry.stepIndex <= resultStepIndex) continue;
      if (entry.type === "SYSTEM_MESSAGE") {
        const sysContent = entry.content ?? "";
        if (sysContent.includes(`Task id "${taskId}" finished`)) {
          let output = "";
          const resultMarker = "finished with result:\n";
          const markerIdx = sysContent.indexOf(resultMarker);
          if (markerIdx !== -1) {
            output = sysContent.slice(markerIdx + resultMarker.length).trim();
          } else {
            const shortMarker = "finished with result:";
            const shortIdx = sysContent.indexOf(shortMarker);
            if (shortIdx !== -1) {
              output = sysContent.slice(shortIdx + shortMarker.length).trim();
            } else {
              output = sysContent.trim();
            }
          }
          return {
            output,
            status: "completed",
            error: null,
          };
        }
      }
    }
    return null;
  }

  if (resultEntry.type === "GENERIC" && (resultEntry.content !== undefined || resultEntry.error !== undefined)) {
    const failure =
      resultEntry.error && resultEntry.error.trim().length > 0
        ? toolFailureError(resultEntry.error)
        : null;
    return {
      output: resultEntry.content ?? "",
      status: failure !== null ? "failed" : "completed",
      error: failure,
    };
  }

  return null;
}

function startBackgroundCommandWatcher(session: AcpSession, emit: Emit): void {
  if (session.backgroundWatcherTimer || session.closing) return;
  if (session.backgroundCommands.size === 0) return;

  const parentConversationId = session.conversationId;
  if (!parentConversationId) return;

  const geminiRoot = accountGeminiRoot(session.accountId);
  const parentTranscriptPath = conversationTranscriptPath(geminiRoot, parentConversationId);
  const POLL_MS = session.backgroundPollMs ?? 200;

  const check = async (): Promise<void> => {
    if (session.closing || session.backgroundCommands.size === 0) {
      stopBackgroundCommandWatcher(session);
      return;
    }

    try {
      let content = "";
      if (session.readTranscriptFile) {
        content = await session.readTranscriptFile(parentTranscriptPath);
      } else if (existsSync(parentTranscriptPath)) {
        content = await readFile(parentTranscriptPath, "utf8");
      }

      if (content.length > 0) {
        const { entries } = parseTranscriptLines(content);
        for (const [rowId, tracked] of Array.from(session.backgroundCommands.entries())) {
          const completion = findBackgroundCommandCompletion(entries, tracked);
          if (completion) {
            session.backgroundCommands.delete(rowId);

            const detail = { ...tracked.tool.detail };
            if (detail.type === "shell") {
              detail.output = completion.output;
            } else if (detail.type === "plain_text") {
              detail.text = completion.output;
            }

            const updatedTool: ProviderToolCallItem =
              completion.status === "failed"
                ? {
                    ...tracked.tool,
                    detail,
                    status: "failed",
                    error: completion.error,
                  }
                : {
                    ...tracked.tool,
                    detail,
                    status: "completed",
                    error: null,
                  };
            publish(session, emit, updatedTool);

            scheduleAutoContinue(session, emit, {
              type: "command",
              title: `Background command "${tracked.command}" finished. Output:`,
              body: completion.output.slice(0, 4000),
            });
          }
        }
      }
    } catch {
      // Best-effort
    }

    if (session.backgroundCommands.size === 0) {
      stopBackgroundCommandWatcher(session);
    }
  };

  const poll = async () => {
    if (session.closing) {
      stopBackgroundCommandWatcher(session);
      return;
    }
    await check();
    if (!session.closing && session.backgroundCommands.size > 0) {
      session.backgroundWatcherTimer = setTimeout(poll, POLL_MS);
      session.backgroundWatcherTimer.unref();
    } else {
      stopBackgroundCommandWatcher(session);
    }
  };

  session.backgroundWatcherTimer = setTimeout(poll, POLL_MS);
  session.backgroundWatcherTimer.unref();
}

function stopBackgroundCommandWatcher(session: AcpSession): void {
  if (session.backgroundWatcherTimer) {
    clearTimeout(session.backgroundWatcherTimer);
    session.backgroundWatcherTimer = null;
  }
}

function scheduleAutoContinue(session: AcpSession, emit: Emit, item: AutoContinueItem): void {
  if (session.closing) return;
  if (session.activeTurn !== null) {
    return;
  }

  session.pendingAutoItems.push(item);

  if (session.autoContinueTimer !== null) {
    return;
  }

  const delayMs = session.autoContinueDelayMs ?? 2000;
  session.autoContinueTimer = setTimeout(() => {
    session.autoContinueTimer = null;
    if (session.closing || session.pendingAutoItems.length === 0) return;
    if (session.activeTurn !== null) {
      session.pendingAutoItems = [];
      return;
    }

    if (session.consecutiveAutoContinuations >= 5) {
      session.pendingAutoItems = [];
      emitNotice(
        session,
        emit,
        "agy-auto-continue-cap",
        "info",
        "Subagent finished — send a message to continue",
        "Subagent finished — send a message to continue",
      );
      return;
    }

    const items = [...session.pendingAutoItems];
    session.pendingAutoItems = [];
    session.consecutiveAutoContinuations += 1;

    const text = formatAutoContinueMessage(items);
    void startAutoContinueTurn(session, text, emit);
  }, delayMs);
  session.autoContinueTimer.unref();
}

async function startAutoContinueTurn(session: AcpSession, text: string, emit: Emit): Promise<void> {
  if (session.closing || session.activeTurn !== null) return;
  const client = await ensureClient(session, emit);
  if (session.closing || session.activeTurn !== null) return;

  session.turnCounter += 1;
  const turnId = `turn-${session.turnCounter}-${randomUUID().slice(0, 8)}`;

  publish(session, emit, {
    type: "user_message",
    id: `auto:${turnId}`,
    text,
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
    currentMessageId: `agy:msg:${turnId}:0`,
    currentMessageText: "",
    currentThoughtId: `agy:thought:${turnId}:0`,
    currentThoughtText: "",
    messageIndex: 0,
    thoughtIndex: 0,
    openTools: new Map(),
    activePromptPromise: promptPromise,
    isPlan: false,
  };
  session.activeTurn = activeTurn;

  try {
    const actualPromptPromise = client.prompt([{ type: "text", text }]);
    actualPromptPromise.then(resolvePrompt, rejectPrompt);
    await runTurnPrompt(session, activeTurn, promptPromise, emit);
  } catch (err) {
    handleProcessExitOrCrash(
      session,
      err instanceof Error ? err : new Error(String(err)),
      emit,
    );
  }
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  session: AcpSession,
  emit: Emit,
): Promise<void> {
  const { prompt } = input;

  if (session.autoContinueTimer !== null) {
    clearTimeout(session.autoContinueTimer);
    session.autoContinueTimer = null;
  }
  session.pendingAutoItems = [];
  session.consecutiveAutoContinuations = 0;

  if (prompt.outputSchema !== undefined) {
    if (session.activeTurn !== null) {
      emit({
        type: "session.prompt_result",
        sessionId: session.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: "failed",
          error: {
            message:
              "Antigravity applies a structured-output schema to the whole process, so this prompt cannot be queued behind a running turn. Wait for the turn to finish and send it again.",
            code: "busy",
          },
        },
      });
      return;
    }

    const schema = objectRootSchema(prompt.outputSchema);
    if ("refusal" in schema) {
      emit({
        type: "session.prompt_result",
        sessionId: session.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: "failed",
          error: {
            message: schema.refusal,
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

    if (!session.conversationId) {
      try {
        await ensureClient(session, emit);
      } catch (err) {
        emit({
          type: "session.prompt_result",
          sessionId: session.sessionId,
          clientMessageId: prompt.clientMessageId,
          result: {
            type: "failed",
            error: {
              message: `Failed to initialize conversation for structured output: ${err instanceof Error ? err.message : String(err)}`,
              code: "agy_launch_failed",
            },
          },
        });
        return;
      }
    }

    if (session.client) {
      await session.client.close();
      session.client = null;
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

    const schemaPath = pluginDataDir("schemas", `${session.sessionId.replace(unsafePathChars, "_")}.json`);
    try {
      await mkdir(dirname(schemaPath), { recursive: true });
      await writeFile(schemaPath, JSON.stringify(schema.schema), "utf8");
    } catch (err) {
      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId,
        state: "failed",
        error: {
          message: `Could not write the output schema for Antigravity: ${err instanceof Error ? err.message : String(err)}`,
          code: "schema_failed",
        },
      });
      return;
    }

    const promptText = content.map((c) => (c.type === "text" ? c.text : "")).join("\n\n");
    const options = readProviderOptions(session.config);
    const binary = options.agyPath ?? resolveAgyBinary();
    const home = accountHome(session.accountId);
    if (home !== null) syncShadowHome(session.accountId);
    const env = home === null ? session.config.env : { ...session.config.env, HOME: home };

    const args = buildOneShotAgyArgs({
      promptText,
      conversationId: session.conversationId!,
      schemaPath,
      model: session.selection.model,
      thinkingOption: session.selection.thinkingOption,
      mode: session.selection.mode,
      accountId: session.accountId,
      skipPermissions: approvalPolicy(session) === "skip",
      extraArgs: options.extraArgs,
    });

    console.log(`[antigravity] spawn ${binary} ${args.join(" ")} (cwd ${session.config.cwd})`);

    const runner = session.runOneShot ?? defaultRunOneShot;
    let runResult: OneShotResult;
    try {
      runResult = await runner({
        binary,
        args,
        cwd: session.config.cwd,
        env,
      });
    } catch (err) {
      const failure = turnFailure({ agyError: null }, { message: err instanceof Error ? err.message : String(err), code: "agy_exit" });
      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId,
        state: "failed",
        error: failure.error,
      });
      return;
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(runResult.stdout.trim());
    } catch {
      // Non-JSON stdout
    }

    if (runResult.code === 0 && parsed && (parsed.status === "SUCCESS" || (!parsed.status && parsed.structured_output !== undefined))) {
      if (parsed.structured_output !== undefined) {
        const json = JSON.stringify(parsed.structured_output);
        publish(session, emit, {
          type: "assistant_message",
          id: `agy:schema:${turnId}`,
          text: json ?? "",
        });
      } else {
        publish(session, emit, {
          type: "assistant_message",
          id: `agy:result:${turnId}`,
          text: parsed.response ?? "",
        });
      }

      if (parsed.usage) {
        emit({
          type: "session.usage",
          sessionId: session.sessionId,
          turnId,
          usage: {
            inputTokens: parsed.usage.input_tokens ?? parsed.usage.inputTokens,
            cachedInputTokens: parsed.usage.cache_read_tokens ?? parsed.usage.cachedReadTokens,
            outputTokens:
              (parsed.usage.output_tokens ?? parsed.usage.outputTokens ?? 0) +
                (parsed.usage.thinking_tokens ?? parsed.usage.thoughtTokens ?? 0) || undefined,
          },
        });
      }

      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId,
        state: "completed",
      });
    } else {
      const msg = parsed?.error ?? (runResult.stderr.trim() || parsed?.response || "One-shot agy failed");
      const code = parsed?.status ?? "agy_exit";
      const failure = turnFailure({ agyError: null }, { message: msg, code });
      emit({
        type: "session.turn",
        sessionId: session.sessionId,
        turnId,
        state: "failed",
        error: failure.error,
      });
    }

    return;
  }

  const isPlanCommand = prompt.input.type === "command" && prompt.input.name === PLAN_COMMAND;
  const isPlanMode = isPlanCommand || session.selection.mode === PLAN_MODE_ID;
  const previousMode = session.selection.mode;

  if (session.pendingPlan !== null) {
    resolvePendingPlan(session, emit);
    if (session.selection.mode !== previousMode && session.selection.mode && session.client?.running) {
      void session.client.setMode(session.selection.mode);
    }
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
      const client = await ensureClient(session, emit);
      // Steering race: if running turn completed before prompt is sent, start a normal new turn
      if (session.activeTurn !== null) {
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
      // Running turn completed while waiting for client; fall through to start a normal new turn!
    } else {
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
    isPlan: isPlanMode,
    previousMode,
  };
  session.activeTurn = activeTurn;

  void (async () => {
    let client: AgyAcpClient;
    try {
      client = await ensureClient(session, emit);
      if (isPlanCommand) {
        await client.setMode(PLAN_MODE_ID);
      }
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

async function respondToPermission(
  input: Extract<ProviderInput, { type: "session.permission" }>,
  session: AcpSession,
  emit: Emit,
): Promise<void> {
  const permId = input.permissionId;

  // 1. Plan card
  if (session.pendingPlan && (session.pendingPlan.id === permId || permId.startsWith("plan:"))) {
    const plan = session.pendingPlan;
    session.pendingPlan = null;
    emit({
      type: "session.permission_resolved",
      sessionId: session.sessionId,
      permissionId: permId,
    });

    if (input.response.behavior === "allow") {
      if (session.selection.mode === PLAN_MODE_ID) {
        session.selection.mode = IMPLEMENT_MODE_ID;
        if (session.client?.running) {
          await session.client.setMode(IMPLEMENT_MODE_ID);
        }
        emit({
          type: "session.config",
          sessionId: session.sessionId,
          config: configState(session),
        });
      } else {
        const restoreMode = plan.previousMode ?? session.selection.mode;
        if (restoreMode && session.client?.running) {
          await session.client.setMode(restoreMode);
        }
      }

      await promptSession(
        {
          type: "session.prompt",
          sessionId: session.sessionId,
          prompt: {
            clientMessageId: `plan-impl-${randomUUID().slice(0, 8)}`,
            delivery: "auto",
            input: {
              type: "message",
              content: [{ type: "text", text: IMPLEMENT_PLAN_TEXT }],
            },
          },
        },
        session,
        emit,
      );
    } else {
      if (session.selection.mode !== PLAN_MODE_ID) {
        const restoreMode = plan.previousMode ?? session.selection.mode;
        if (restoreMode && session.client?.running) {
          await session.client.setMode(restoreMode);
        }
      }
    }
    return;
  }

  // 2. Question card
  const question =
    session.pendingQuestions.get(permId) ??
    session.pendingQuestions.get(`question:${permId}`) ??
    [...session.pendingQuestions.values()].find((q) => q.toolCallId === permId);

  if (question) {
    session.pendingQuestions.delete(question.id);
    session.pendingQuestions.delete(question.toolCallId);
    emit({
      type: "session.permission_resolved",
      sessionId: session.sessionId,
      permissionId: permId,
    });

    if (input.response.behavior === "allow") {
      const answers = readAnswers(question.questions, input.response);
      publish(
        session,
        emit,
        questionRow(question.toolCallId, question.questions, { kind: "answered", answers }),
      );

      const content: Record<string, unknown> = {};
      const props = (question.schema?.properties as Record<string, any> | undefined) ?? {};
      const nonOtherKeys = Object.keys(props).filter((k) => !k.endsWith("_other"));

      for (let i = 0; i < question.questions.length; i++) {
        const q = question.questions[i];
        const answer = answers[i];
        if (!answer || answer === NO_ANSWER) continue;

        const propKey = props[`q${i + 1}`] ? `q${i + 1}` : (nonOtherKeys[i] ?? `q${i + 1}`);
        const otherKey = `${propKey}_other`;
        const propSchema = props[propKey];
        const choices = Array.isArray(propSchema?.oneOf)
          ? propSchema.oneOf
          : Array.isArray(propSchema?.anyOf)
            ? propSchema.anyOf
            : typeof propSchema?.items === "object" && propSchema.items !== null
              ? (Array.isArray(propSchema.items.oneOf)
                  ? propSchema.items.oneOf
                  : Array.isArray(propSchema.items.anyOf)
                    ? propSchema.items.anyOf
                    : [])
              : [];

        if (q.multiSelect) {
          const parts = answer.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
          const consts: string[] = [];
          const writeIns: string[] = [];
          for (const part of parts) {
            const match = findChoiceMatch(choices, part);
            if (match) {
              consts.push(String(match.const ?? match.value ?? consts.length + 1));
            } else {
              writeIns.push(part);
            }
          }
          if (consts.length > 0) {
            content[propKey] = consts;
          }
          if (writeIns.length > 0) {
            content[otherKey] = writeIns.join(", ");
          }
        } else {
          const match = findChoiceMatch(choices, answer);
          if (match) {
            content[propKey] = String(match.const ?? match.value ?? "1");
          } else {
            content[otherKey] = answer;
          }
        }
      }

      question.resolve({ action: "accept", content });
    } else {
      publish(
        session,
        emit,
        questionRow(question.toolCallId, question.questions, { kind: "dismissed" }),
      );
      question.resolve({ action: "accept", content: {} });
    }
    return;
  }

  // 3. Tool permission card
  const permission =
    session.pendingPermissions.get(permId) ??
    session.pendingPermissions.get(permId.replace(/^permission:/, "")) ??
    [...session.pendingPermissions.values()].find((p) => p.toolCallId === permId);

  if (permission) {
    session.pendingPermissions.delete(permission.id);
    session.pendingPermissions.delete(permission.toolCallId);
    emit({
      type: "session.permission_resolved",
      sessionId: session.sessionId,
      permissionId: permId,
    });

    const response = input.response;
    let selectedOption: AcpPermissionOption | undefined;

    if (response.selectedActionId) {
      selectedOption = permission.options.find(
        (opt) => opt.optionId === response.selectedActionId,
      );
    }

    if (!selectedOption) {
      const isAllow = response.behavior === "allow";
      const isAlways =
        (isAllow && response.updatedPermissions && response.updatedPermissions.length > 0) ||
        response.selectedActionId?.includes("always");

      if (isAllow) {
        if (isAlways) {
          selectedOption = permission.options.find((opt) => opt.kind === "allow_always");
        }
        if (!selectedOption) {
          selectedOption =
            permission.options.find((opt) => opt.kind === "allow_once") ??
            permission.options.find((opt) => opt.kind?.startsWith("allow")) ??
            permission.options.find((opt) => opt.optionId === "allow");
        }
      } else {
        if (isAlways) {
          selectedOption = permission.options.find((opt) => opt.kind === "reject_always");
        }
        if (!selectedOption) {
          selectedOption =
            permission.options.find((opt) => opt.kind === "reject_once") ??
            permission.options.find((opt) => opt.kind?.startsWith("reject")) ??
            permission.options.find((opt) => opt.optionId === "deny");
        }
      }
    }

    if (selectedOption) {
      permission.resolve({
        outcome: { outcome: "selected", optionId: selectedOption.optionId },
      });
    } else {
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    return;
  }

  emit({
    type: "session.permission_resolved",
    sessionId: session.sessionId,
    permissionId: permId,
  });
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
    if (changes.settings.shareMcp !== undefined && changes.settings.shareMcp !== session.settings.shareMcp) {
      if (session.client?.running) {
        await session.client.close();
        session.client = null;
      }
      emitNotice(
        session,
        emit,
        "mcp-share-changed",
        "info",
        "Paseo tools updated",
        "Sharing Paseo tools with Antigravity will take effect on your next message.",
      );
    }
    if (changes.settings.transport !== undefined && changes.settings.transport !== "acp") {
      emitNotice(
        session,
        emit,
        "transport-change-unsupported",
        "info",
        "Transport cannot be changed",
        "Transport (NDJSON / ACP) is selected when the session is opened and cannot be changed for an existing session.",
      );
    }
    session.settings = { ...session.settings, ...changes.settings, transport: "acp" };
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

  const childCapabilities = state.capabilities.filter((c) => c === "session.subsession");
  const session = new AcpSession(
    input.sessionId,
    config,
    conversationId,
    accountId,
    rawTransport as AgyAcpClientTransport | (() => AgyAcpClientTransport) | undefined,
    options.runOneShot,
    options.readTranscriptFile,
    options.statTranscriptFile,
    childCapabilities,
    options.autoContinueDelayMs,
    options.backgroundPollMs,
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
    persistence: persistenceFor(session.conversationId, accountId, "acp"),
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
      if (session.autoContinueTimer !== null) {
        clearTimeout(session.autoContinueTimer);
        session.autoContinueTimer = null;
      }
      session.pendingAutoItems = [];
      cancelPendingPermissions(session, emit);
      cancelPendingQuestions(session, emit);
      resolvePendingPlan(session, emit);
      for (const follow of session.subagentFollows.values()) {
        follow.transcript?.stop();
        if (follow.opened && !follow.done) {
          emit({
            type: "session.turn",
            sessionId: follow.childId,
            turnId: childTurnId(follow.childConversationId),
            state: "canceled",
            error: { message: "Interrupted" },
          });
          emit({
            type: "session.closed",
            sessionId: follow.childId,
            error: { message: "Interrupted" },
          });
          session.childSessions.delete(follow.childId);
        }
      }
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
      const canStop =
        session.activeTurn === null &&
        session.pendingPermissions.size === 0 &&
        session.pendingQuestions.size === 0 &&
        session.pendingPlan === null &&
        session.backgroundCommands.size === 0 &&
        session.autoContinueTimer === null &&
        session.pendingAutoItems.length === 0 &&
        ![...session.subagentFollows.values()].some((f) => !f.done);
      emit({
        type: "session.can_stop_runtime",
        requestId: input.requestId,
        sessionId: input.sessionId,
        canStop,
      });
      return;
    }
    case "session.permission": {
      const session = requireAcpSession(state, input.sessionId);
      await respondToPermission(input, session, emit);
      return;
    }
    case "session.close": {
      const session = requireAcpSession(state, input.sessionId);
      session.closing = true;
      if (session.autoContinueTimer !== null) {
        clearTimeout(session.autoContinueTimer);
        session.autoContinueTimer = null;
      }
      session.pendingAutoItems = [];
      stopBackgroundCommandWatcher(session);
      session.backgroundCommands.clear();
      for (const timer of session.parentTranscriptWatcherTimers) {
        clearTimeout(timer);
      }
      session.parentTranscriptWatcherTimers.clear();
      cancelPendingPermissions(session, emit);
      cancelPendingQuestions(session, emit);
      resolvePendingPlan(session, emit);
      for (const follow of session.subagentFollows.values()) {
        follow.transcript?.stop();
        if (follow.opened && !follow.done) {
          emit({
            type: "session.closed",
            sessionId: follow.childId,
          });
          session.childSessions.delete(follow.childId);
        }
        if (follow.store) {
          void follow.store.flush();
        }
      }
      session.subagentFollows.clear();
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
): ProviderConnection & { readonly state?: AcpConnectionState } {
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
    state,
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
        if (session.autoContinueTimer !== null) {
          clearTimeout(session.autoContinueTimer);
          session.autoContinueTimer = null;
        }
        session.pendingAutoItems = [];
        stopBackgroundCommandWatcher(session);
        session.backgroundCommands.clear();
        for (const timer of session.parentTranscriptWatcherTimers) {
          clearTimeout(timer);
        }
        session.parentTranscriptWatcherTimers.clear();
        cancelPendingPermissions(session, emit);
        cancelPendingQuestions(session, emit);
        resolvePendingPlan(session, emit);
        for (const follow of session.subagentFollows.values()) {
          follow.transcript?.stop();
          if (follow.opened && !follow.done) {
            emit({
              type: "session.closed",
              sessionId: follow.childId,
            });
            session.childSessions.delete(follow.childId);
          }
          if (follow.store) {
            closingSessions.push(follow.store.flush());
          }
        }
        session.subagentFollows.clear();
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
