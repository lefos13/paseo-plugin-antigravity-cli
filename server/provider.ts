import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, isAbsolute } from "node:path";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderContent,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderSetting,
  type ProviderTimelineItem,
  type ProviderToolCallDetail,
  type ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { TranscriptPoller, conversationTranscriptPath, renderBackfill } from "./backfill";
import {
  DEFAULT_ACCOUNT_ID,
  accountGeminiRoot,
  accountHome,
  readAccounts,
  syncShadowHome,
} from "./accounts";
import { AgyProcess } from "./agy";
import { attachmentsDir, clearAttachments, writeAttachment } from "./attachments";
import { readToolPermission } from "./agysettings";
import {
  isObservedTool,
  isSnapshotTool,
  readSnapshot,
  snapshotTarget,
  type FileSnapshot,
} from "./edits";
import {
  DEFAULT_MODE_ID,
  DEFAULT_MODEL_ID,
  MODES,
  buildCatalog,
  catalogCacheKey,
  currentModels,
  invalidateCatalogCache,
  resolveThinking,
} from "./catalog";
import {
  MAX_SKILL_BYTES,
  discoverAgents,
  discoverCommands,
  renderSkillPrompt,
  type DiscoveredAgent,
} from "./commands";
import {
  STEP_AGENT_RESPONSE,
  STEP_STATE_DONE,
  STEP_SUBAGENT,
  STEP_TOOL,
  STEP_UNKNOWN,
  isInterrupted,
  parseAgyErrorLine,
  type AgyErrorReport,
  type AgyEvent,
  type AgyResult,
  type AgyStepUpdate,
  type AgyUsage,
} from "./protocol";
import { injectMcpServers, mcpConfigPath, releaseMcpServers, sweepMcpLedger } from "./mcp";
import { pluginDataDir, unsafePathChars } from "./plugindata";
import {
  answerPrompt,
  answerShown,
  findSkippedQuestion,
  questionRequest,
  questionRow,
  readAnswers,
  type AgyQuestion,
  type SkippedQuestion,
} from "./questions";
import { listConversations } from "./sessions";
import {
  SubagentTranscript,
  parseTranscriptLines,
  transcriptFilePath,
  type ChildRender,
  type ChildSpawn,
} from "./subagents";
import { TranscriptStore, transcriptExists } from "./transcript";
import { hasEditContent, mapToolDetail, snapshotDiff } from "./tools";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const PROVIDER_ID = "antigravity-cli";
const STDERR_TAIL = 20;
/** Whole files remembered per session for diffing, newest last. */
const OBSERVED_LIMIT = 32;
/**
 * How long a tool may stay ACTIVE before the conversation transcript is consulted. A command agy
 * moved to the background holds every later stream line until it ends (see `backfill.ts`).
 */
const BACKFILL_DELAY_MS = 5_000;

const PLAN_MODE_ID = "plan";
/** The slash command that runs as a plugin plan-mode turn instead of agy's own `/plan` workflow. */
const PLAN_COMMAND = "plan";
/** The mode an approved plan is implemented in. */
const IMPLEMENT_MODE_ID = "accept-edits";
/**
 * How often the transcript is read for a question's step before giving up. The line was already on
 * disk when the stream reported the step in every probe; the retries cover a slow flush.
 */
const QUESTION_READ_ATTEMPTS = 5;
const QUESTION_READ_RETRY_MS = 100;
/**
 * agy's `--mode plan` is never passed (`ensureProcess` explains why): it takes effect only while
 * slash-command expansion is on, and with expansion on the CLI approves its own plan review and
 * implements in the same turn. So plan mode is the plugin's to enforce: every plan-mode turn
 * carries this preamble, and its answer is offered as a plan.
 */
const PLAN_MODE_PREAMBLE = `<plan_mode>
Plan mode is on. Do not create, edit, move or delete any file, and do not run commands that change anything: no installs, builds that write output, git commits, servers or other side effects. Read-only investigation — reading files, searching, and read-only commands — is allowed.
End your turn with a concrete implementation plan for the user to approve: the files to change, what changes in each, and how the result will be verified. Do not implement the plan; the user will approve it first.
</plan_mode>`;
/** What the plugin sends once the user approves a plan. */
const IMPLEMENT_PLAN_TEXT = "The plan is approved. Implement it now.";

/**
 * A transient Antigravity outage. Captured verbatim from a real one as
 * `UNAVAILABLE (code 503): The service is currently unavailable.` in the failed result's `error`
 * (fixtures/05-unavailable.ndjson). The check is deliberately narrow: widening it would label a
 * permanent failure such as `model does-not-exist is not recognized` as worth retrying.
 */
const UNAVAILABLE_PATTERN = /\bUNAVAILABLE\b|\b503\b/;

/**
 * `prompt.steer` is deliberately absent: a line written to agy stdin while a turn is running is
 * queued into a following turn rather than applied to the running one, so Paseo replaces the
 * active turn instead. agy resolves tool approvals internally and cannot surface them over this
 * protocol, so the only permission this provider ever requests is the plugin's own plan approval.
 *
 * `prompt.command` is supported by relaunching: a command turn runs on a CLI launched without
 * `--disable-slash-commands`, and the next plain turn relaunches with it again (see the launch
 * profile), because that flag also decides whether plain text starting with `/` expands.
 *
 * `permission.tool_policy` is accepted because `session.open` is rejected outright when the
 * config carries a `toolPolicy` and the capability is missing. Preapproved MCP tools cannot be
 * forwarded to agy, which reads its own rules from settings.json; that is covered by the MCP
 * notice emitted on session open.
 */
const CAPABILITIES = [
  "prompt.message",
  // A slash command reaches the CLI as `/<name> <arguments>` on a process launched for it.
  "prompt.command",
  // Images cannot go over the stream (agy rejects image blocks), so they are written to the
  // plugin's attachments folder and referenced by path in the text.
  "prompt.image",
  // `--json-schema` makes agy decode the answer against a schema; the turn's last assistant row
  // then holds that JSON (see the SUCCESS branch of `handleResult`).
  "prompt.output_schema",
  "session.configure",
  // Antigravity's own conversation index is readable, which is what makes import possible.
  "session.list",
  "session.persistence",
  // A subagent run is followed through the transcript agy writes for its own conversation, and is
  // published as a child session under the invoke_subagent row that spawned it.
  "session.subsession",
  // A plan-mode turn ends with a plan the user approves or dismisses (`offerPlan`).
  "permission",
  "permission.tool_policy",
] as const;

export function createProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "Antigravity",
    description: "Run, monitor, and steer Antigravity sessions from Paseo",
    icon: "icon.svg",
    async getCatalogCacheKey(options) {
      // Catalog inputs carry no providerOptions, so a per-session `agyPath` cannot reach the
      // catalog; the key follows the resolved binary, its build, the environment override, and the
      // active account — `agy models` runs under that account's `HOME`, so its list can change
      // with it. `force` is the caller asking for a refresh, which the in-process cache must not
      // answer with the list it already has.
      if (options.force) invalidateCatalogCache();
      return catalogCacheKey(readAccounts().active);
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Antigravity provider requires provider protocol version 1");
      }
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

interface Session {
  readonly sessionId: string;
  readonly config: ProviderSessionConfig;
  readonly agyPath?: string;
  readonly extraArgs?: readonly string[];
  /** Absolute, existing directories from `providerOptions.addDirs`, passed as extra --add-dir. */
  readonly addDirs: readonly string[];
  readonly agent?: string;
  /**
   * `providerOptions.effort`. It only becomes the launch slug's tier (`resolveEffort`) or, with no
   * model selected, the one `--effort` flag; it is never passed alongside `--model`.
   */
  readonly effort?: string;
  /** The last effort drop `applyProviderEffort` named, so a relaunch does not report it again. */
  effortNotice: string | null;
  readonly availableAgents: readonly DiscoveredAgent[];
  settings: Record<string, JsonValue>;
  /**
   * The composer's selectors. `model` and `thinkingOption` are kept as they were chosen — a
   * persisted full slug such as `gemini-3.8-flash-high` stays itself — and are resolved together
   * into the `--model` slug at launch (`resolveThinking`).
   */
  selection: { model?: string; mode?: string; thinkingOption?: string };
  conversationId: string | null;
  /**
   * The account every launch of this session runs under: the one the conversation was created
   * with on resume, the active one on open. Changing the active account never moves a session.
   */
  readonly accountId: string;
  /** `persist: false` keeps the conversation resumable but writes no timeline to disk. */
  readonly persist: boolean;
  transcript: TranscriptStore | null;
  /** Rows published before `init` supplied a conversation id, drained into the store on init. */
  unpersisted: ProviderTimelineItem[];
  process: AgyProcess | null;
  /** Set when a selector changed but the CLI still runs with the previous launch flags. */
  needsRestart: boolean;
  /** The one schema file this session's `--json-schema` points at. */
  readonly schemaPath: string;
  /**
   * What the *next* launch must carry. `--json-schema` and `--disable-slash-commands` are fixed at
   * launch, so a turn that needs a different profile replaces the CLI first.
   */
  launchPending: LaunchProfile;
  /** What the running CLI was actually launched with. */
  launchActive: LaunchProfile;
  /** Extra `--add-dir` holding attached images; null when the folder could not be created. */
  readonly attachmentsDir: string | null;
  /** Number of images written for this session, so filenames stay unique within it. */
  attachmentCount: number;
  /**
   * Where the workspace's `.agents/mcp_config.json` stands for this session: `applied` when the
   * plugin's entries are in it, `error` when the last attempt failed and reported why, and
   * `released` when nothing of this session's is (or should be) in it.
   */
  mcp: "applied" | "released" | "error";
  /**
   * Names the composer was shown as plugin-expanded when this session opened. A command the user
   * picks from that list is served from a fresh read of the same roots; this set is what tells a
   * name that has since disappeared from a name the CLI expands itself.
   */
  publishedSkills: Set<string>;
  systemPromptSent: boolean;
  turnCounter: number;
  /** Turns written to agy that have not reported a result yet, oldest first. */
  pendingTurns: PendingTurn[];
  /**
   * The content of files the plugin has been shown, newest last. agy applies an edit *before* it
   * reports the step as ACTIVE (probed: the rewritten file is on disk when the ACTIVE line
   * arrives), so the step's own snapshot is already the state after the edit; what the plugin saw
   * earlier is then the only usable "before".
   */
  observed: Map<string, Promise<FileSnapshot | null>>;
  /**
   * Rows published for `invoke_subagent` steps, keyed by call id and kept past the turn that
   * published them: a subagent row outlives its turn, because the child it names is still running
   * after the parent's step is DONE and may still be running when the turn ends.
   */
  subagents: Map<string, SubagentRow>;
  /** Children whose transcripts are being followed, keyed by the row that spawned them. */
  follows: Map<string, ChildFollow>;
  /**
   * Every child session this parent opened, in the order they opened, whether it is being followed
   * or was re-opened by a replay for a child that had already finished. A replay leaves no tailer
   * behind it, so this set is the only record that such a child exists and closes with its parent.
   */
  childSessions: Set<string>;
  stderrTail: string[];
  /** Structured `AGY_ERROR` line of the current process, if it printed one. */
  agyError: AgyErrorReport | null;
  interrupting: boolean;
  closing: boolean;
  /**
   * A CLI whose last turn was settled from the conversation transcript while its stream was still
   * held behind a background task (see `backfill.ts`). It is kept alive — the task it holds is
   * often a dev server the answer just told the user about — but it can never take another turn:
   * a line written to it would queue behind that task. It is not idle either: when a background
   * task ends, agy hands the model its result and the settled turn carries on, unseen. So its
   * transcript is watched, and the first step past the settled answer disposes it
   * (`stopIfResumed`), as does the next prompt or close.
   */
  detached: DetachedCli | null;
  /** The plan a plan-mode turn ended with, while the user has not approved or dismissed it. */
  pendingPlan: { id: string; text: string } | null;
  /** The questions a stopped turn asked, while the user has not answered or dismissed them. */
  pendingQuestion: {
    id: string;
    callId: string;
    questions: readonly AgyQuestion[];
    /** The asking turn was a plan, so the turn that answers it is one too. */
    plan: boolean;
  } | null;
  /**
   * Whether the host negotiated `permission`, without which neither a plan nor a question card can
   * be offered.
   */
  readonly planApproval: boolean;
}

/**
 * The launch-time flags that decide how a turn is served. All of them are fixed for the life of
 * the process, so a prompt that needs another profile gets a relaunched CLI instead.
 */
interface LaunchProfile {
  /** Launched with `--json-schema`: the turn's answer is decoded JSON, not prose. */
  schema: boolean;
  /** Launched without `--disable-slash-commands`: `/name` expands, in a command turn only. */
  commands: boolean;
  /** The skill directory this process may read, for a plugin-expanded skill's turn, else null. */
  skillDir: string | null;
}

/** A CLI left holding a background task, and the watch that stops it once its model resumes. */
interface DetachedCli {
  readonly process: AgyProcess;
  readonly watch: TranscriptPoller;
}

/**
 * agy runs queued stdin lines in order, so the *oldest* pending turn owns every incoming event:
 * a prompt sent while another turn is streaming must not relabel that turn's rows or clear the
 * text it has already accumulated.
 */
interface PendingTurn {
  readonly turnId: string;
  /** Incremental assistant text per step_index, accumulated into complete snapshots. */
  readonly assistant: Map<number, string>;
  /** Tool rows published as `running` and not yet complete, keyed by call id. */
  readonly tools: Map<string, OpenToolCall>;
  /** The target file as it was when a snapshot tool started, keyed by call id. */
  readonly snapshots: Map<string, Promise<FileSnapshot | null>>;
  hadAssistantText: boolean;
  /**
   * Whether the CLI serving this turn was launched with `--json-schema`. Antigravity keeps a
   * schema with the *conversation* and reports the last `structured_output` again on later turns
   * of that conversation, even on a process started without the flag (probed 2026-09-23), so the
   * flag is what distinguishes this turn's answer from a stale one. The same flag decides that the
   * turn's text is buffered instead of streamed (see `handleStepUpdate`).
   */
  schema: boolean;
  /**
   * `input_tokens` of the last agent_response step that reported usage: the size the model's
   * context had reached, as opposed to the result's total across every step of the turn.
   */
  contextInputTokens?: number;
  /** Highest step index the stream has delivered for this turn. */
  lastStreamStep: number;
  /**
   * Steps published from the conversation transcript while the stream was held, with the JSON
   * last published for each. The stream no longer owns these steps: when it catches up, its copy
   * of them is dropped rather than published a second time.
   */
  readonly backfilled: Map<number, string>;
  backfill: TranscriptPoller | null;
  backfillTimer: NodeJS.Timeout | null;
  /** The exact text written to agy, so a turn queued behind a detached CLI can be sent again. */
  outgoing: string;
  /** Sent in plan mode, so its answer is offered as a plan to implement. */
  plan: boolean;
}

/** The fields of a tool row, kept so a call left open can be republished with a terminal status. */
interface OpenToolCall {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly detail: ProviderToolCallDetail;
  readonly metadata: Record<string, JsonValue>;
}

type SubAgentDetail = Extract<ProviderToolCallDetail, { type: "sub_agent" }>;

/** What a subagent row knows about its child, published under `metadata.subagent`. */
interface SubagentInfo {
  index: number;
  conversationId?: string;
  logUri?: string;
  typeName?: string;
  role?: string;
  prompt?: string;
  done?: boolean;
  workspaceUris?: readonly string[];
}

/**
 * One row of an `invoke_subagent` step, whether it was reported as a tool line carrying the
 * children's prompts or as a subagent line carrying the ids of the conversations they run in.
 *
 * The row is in `turn.tools` while its turn is pending — where it must always hold what is
 * currently true, because `finalizeToolCalls` republishes from there — and in `session.subagents`
 * afterwards, because the child outlives the turn and can still add its report to it.
 */
interface SubagentRow {
  /** The row as last published; `detail` and `metadata` are rebuilt by `refreshSubagentRow`. */
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  detail: SubAgentDetail;
  metadata: Record<string, JsonValue>;
  /** The turn that published it, so a child can be attributed to the turn that spawned it. */
  readonly turnId: string | null;
  /**
   * The follow of the child whose own timeline this row is drawn in, or null for a row of the
   * conversation itself. A subagent that starts subagents of its own nests them here.
   */
  readonly host: ChildFollow | null;
  readonly stepIndex: number;
  info: SubagentInfo;
  /** The report the child sent, once it has one; the prompt until then. */
  log: string;
  actions?: SubagentAction[];
  /**
   * `running` until something settles the row: the child finishing, the turn ending in SUCCESS, or
   * the turn being canceled or failed. A row that is already terminal keeps that status, because
   * neither path may claim more than the other about a child that did or did not finish.
   */
  status: "running" | "completed" | "canceled" | "failed";
  error: JsonValue;
  /** Set once the child session was opened, which is also what links the row to it. */
  childSessionId: string | null;
  /**
   * The JSON this row was last published as, or null while it never was. A render publishes the
   * row only when this changes, so a child that reports nothing new costs neither a Paseo row nor
   * a write to the parent's transcript.
   */
  published: string | null;
}

/** One entry of a subagent row's action list, as the child's own transcript reports it. */
interface SubagentAction {
  index: number;
  toolName: string;
  summary?: string;
}

/** A child whose transcript this plugin is following, and the rows its steps become. */
interface ChildFollow {
  /** The subagent row that names this child. */
  readonly rowId: string;
  readonly childConversationId: string;
  /** The child's session id in Paseo's namespace. */
  readonly childId: string;
  /** The turn that spawned it, or null for a child resumed from a replayed row. */
  readonly turnId: string | null;
  /**
   * Where the child works: its own worktree for a `Workspace: branch` child, the parent's
   * directory otherwise (`resolveChildCwd`). Both its transcript and its session row use it.
   */
  readonly cwd: string;
  /** Assigned right after construction: the tailer's handlers need the follow they belong to. */
  transcript: SubagentTranscript;
  /** Null when the parent session is not persisted: the child's rows are then not stored either. */
  store: TranscriptStore | null;
  /** Whether the child's session events have been emitted; the session opens lazily. */
  opened: boolean;
  /** Whether the child reached its own last word. */
  done: boolean;
  /** The follow of the child that started this one, or null when the conversation itself did. */
  readonly host: ChildFollow | null;
  /** The session whose timeline holds the row naming this child: the conversation, or its host. */
  readonly hostSessionId: string;
  /** The conversation this child reports to: the conversation itself, or its host. */
  readonly parentConversationId: string;
  /** How many children above this one there are; 0 for a child of the conversation. */
  readonly depth: number;
  /** Rows of the subagents this child started that are still to finish. */
  readonly nested: Set<string>;
  /** The child said its last word while subagents of its own were still running. */
  closePending: boolean;
}

/** The error a failed turn reports, and whether retrying is likely to help. */
interface TurnFailure {
  error: ProviderError;
  retryable: boolean;
}

interface ConnectionState {
  capabilities: readonly ProviderCapability[];
  sessions: Map<string, Session>;
}

type Emit = (event: ProviderEvent) => void;

function createConnection(capabilities: readonly ProviderCapability[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const state: ConnectionState = { capabilities, sessions: new Map() };
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
      console.log(`[antigravity] input ${describeInput(input)}`);
      validateAdmission(input, state);
      await dispatch(input, state, emit);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const running: AgyProcess[] = [];
      const flushing: Promise<void>[] = [];
      const releasing: Promise<void>[] = [];
      for (const session of state.sessions.values()) {
        session.closing = true;
        if (session.process) running.push(session.process);
        const detached = takeDetached(session);
        if (detached) running.push(detached);
        session.process = null;
        for (const turn of session.pendingTurns) stopBackfill(turn);
        if (session.transcript) flushing.push(session.transcript.flush());
        // A child is followed by a watcher and a timer of its own, and its rows live in a store of
        // its own: both end with the connection that started them.
        for (const follow of session.follows.values()) {
          follow.transcript.stop();
          if (follow.store) flushing.push(follow.store.flush());
        }
        session.follows.clear();
        // A close without a session.close: entries this connection injected still belong to it.
        releasing.push(releaseMcpServers(session.sessionId));
      }
      state.sessions.clear();
      listeners.clear();
      // The rows of the last turn are still inside the debounce window, so flushing before the
      // processes are disposed is what lets a reload replay the answer that just finished.
      await Promise.all([...flushing, ...releasing]);
      await Promise.all(running.map((process) => process.dispose()));
    },
  };
}

function validateAdmission(input: ProviderInput, state: ConnectionState): void {
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

async function dispatch(input: ProviderInput, state: ConnectionState, emit: Emit): Promise<void> {
  switch (input.type) {
    case "catalog":
      // Not per session: the composer's global list is the active account's, exactly as a new
      // session's launch would be.
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
      await openSession(input, state, emit);
      return;
    case "session.prompt":
      await promptSession(input, state, emit);
      return;
    case "session.interrupt":
      await interruptSession(input, state, emit);
      return;
    case "session.permission":
      await respondToPermission(input, state, emit);
      return;
    case "session.configure":
      await configureSession(input, state, emit);
      return;
    case "session.close":
      await closeSession(input, state, emit);
      return;
    default:
      throw new Error(`Unsupported provider input: ${(input as { type: string }).type}`);
  }
}

/**
 * How `providerOptions.effort` reaches the CLI.
 *
 * `--effort` is never passed next to `--model`: agy refuses every model id alongside it
 * (`--effort is not supported for model "X"` for one without tiers, `--model X conflicts with
 * --effort=Y` for a tiered slug). A model selected by the composer therefore keeps its effort in
 * the slug — a tier its family lists becomes the session's thinking option, which `resolveThinking`
 * folds into the id — and any other effort is dropped. With no model selected the effort applies to
 * the CLI's own default model, which is the only family that can validate it.
 */
function resolveEffort(
  model: string | undefined,
  effort: string | undefined,
  accountId: string,
): { thinkingOption?: string; flag?: string; dropped?: string } {
  if (effort === undefined) return {};
  // Every way of saying "no model" behaves alike: the effort then belongs to the CLI's own choice.
  const selected = model !== undefined && model.length > 0 ? model : undefined;
  const options = resolveThinking(selected ?? DEFAULT_MODEL_ID, undefined, accountId).options;
  if (options.some((option) => option.id === effort)) {
    return selected === undefined ? { flag: effort } : { thinkingOption: effort };
  }
  const available = options.map((option) => option.id).join(", ");
  return {
    dropped:
      available.length > 0
        ? `${selected ?? DEFAULT_MODEL_ID} has no "${effort}" effort (available: ${available})`
        : `${selected ?? DEFAULT_MODEL_ID} has no reasoning tiers`,
  };
}

/**
 * Applies `providerOptions.effort` to the session (`resolveEffort`) and returns the `--effort` the
 * next launch may carry, naming a dropped effort once so a relaunch does not repeat it. Called at
 * open, on every configure, and before each launch, because the model may change in between.
 */
function applyProviderEffort(session: Session): string | undefined {
  const effort = resolveEffort(session.selection.model, session.effort, session.accountId);
  if (effort.dropped !== undefined && effort.dropped !== session.effortNotice) {
    session.effortNotice = effort.dropped;
    console.log(`[antigravity] ignoring effort "${session.effort}": ${effort.dropped}`);
  }
  // A model chosen after the session opened may have the tier the effort asked for; adopting it
  // keeps the slug and the committed config (`configState`) in agreement.
  if (session.selection.thinkingOption === undefined && effort.thinkingOption !== undefined) {
    session.selection.thinkingOption = effort.thinkingOption;
  }
  return effort.flag;
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const config = input.config;
  const conversationId = persistenceField(input.persistence, "conversationId");
  // Resolved before anything else: an account that no longer exists has no home to launch in, and
  // the failure has to name it rather than start a session that cannot run.
  const accountId = resolveAccountId(input.persistence, conversationId);
  const options = readProviderOptions(config);
  const persist = config.persist !== false;
  const attachmentsDir = await prepareAttachmentsDir(input.sessionId);
  const addDirs = await checkAddDirs(options.addDirs);
  // The workspace's own agents are hidden until the *session's* account trusts the workspace, and
  // that trust lives in the account's settings file, which the launch's `HOME` selects.
  const availableAgents = await discoverAgents(config.cwd, accountGeminiRoot(accountId));

  // Computed before this session joins the map: a conversation with no timeline of this plugin's
  // own is one that already existed in Antigravity. Another open session's rows may still be
  // inside its write debounce, so those count as stored too.
  const knownHistory =
    conversationId !== null &&
    (transcriptExists(conversationId) ||
      [...state.sessions.values()].some(
        (other) => other.conversationId === conversationId && other.transcript !== null,
      ));

  const session: Session = {
    sessionId: input.sessionId,
    config,
    agyPath: options.agyPath,
    extraArgs: options.extraArgs,
    addDirs: addDirs.kept,
    agent: options.agent,
    effort: options.effort,
    effortNotice: null,
    availableAgents,
    settings: { ...config.settings },
    selection: {
      model: config.model,
      mode: config.mode ?? DEFAULT_MODE_ID,
      // `providerOptions.effort` fills this in below; an explicit composer tier wins over it.
      thinkingOption: config.thinkingOption,
    },
    conversationId,
    accountId,
    persist,
    transcript:
      persist && conversationId !== null ? await TranscriptStore.load(conversationId) : null,
    unpersisted: [],
    process: null,
    needsRestart: false,
    // One file per session: rewritten before each schema turn, removed on close.
    schemaPath: pluginDataDir("schemas", `${input.sessionId.replace(unsafePathChars, "_")}.json`),
    launchPending: { schema: false, commands: false, skillDir: null },
    launchActive: { schema: false, commands: false, skillDir: null },
    attachmentsDir,
    attachmentCount: 0,
    mcp: "released",
    publishedSkills: new Set(),
    systemPromptSent: conversationId !== null,
    turnCounter: 0,
    pendingTurns: [],
    observed: new Map(),
    subagents: new Map(),
    follows: new Map(),
    childSessions: new Set(),
    stderrTail: [],
    agyError: null,
    interrupting: false,
    closing: false,
    detached: null,
    pendingPlan: null,
    pendingQuestion: null,
    planApproval: state.capabilities.includes("permission"),
  };
  state.sessions.set(input.sessionId, session);
  // Before `session.config`: the tier the effort becomes is what the composer has to show.
  applyProviderEffort(session);

  emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    persistence: persistenceFor(conversationId, accountId),
    title: config.title,
    cwd: config.cwd,
  });
  emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
  // The composer's command picker is filled from this event, and only what arrives before
  // `session.ready` reaches it — including for the throwaway probe a draft opens. Which of these
  // names this plugin expands itself is kept: a later prompt re-reads the roots, and this is what
  // separates a skill that has since disappeared from a name the CLI expands on its own.
  const discovered = await discoverCommands(config.cwd);
  session.publishedSkills = new Set(discovered.expanded.keys());
  emit({
    type: "session.commands",
    sessionId: input.sessionId,
    commands: [...discovered.commands],
  });

  await syncSessionMcp(session, emit);
  // Leftovers from a process that died without releasing its entries: the ledger is the only
  // record of them, and this is where the set of live sessions is known.
  await sweepMcpLedger(new Set(state.sessions.keys()));
  if (session.mcp !== "applied" && Object.keys(config.mcpServers).length > 0) {
    emitNotice(
      session,
      emit,
      "mcp-unsupported",
      "warning",
      "MCP servers are not applied",
      `Antigravity reads MCP servers from ~/.gemini/config/mcp_config.json, and from .agents/mcp_config.json in a workspace. Turn on "Share Paseo tools with Antigravity" in the session settings to have Paseo write its ${Object.keys(config.mcpServers).length} server(s) to ${mcpConfigPath(config.cwd)}, or add them yourself with \`agy mcp add\`.`,
    );
  }
  if (addDirs.dropped.length > 0) {
    emitNotice(
      session,
      emit,
      "add-dirs-dropped",
      "warning",
      "Some extra directories were ignored",
      `providerOptions.addDirs only accepts absolute paths to existing directories. Not passed to Antigravity: ${addDirs.dropped.join(", ")}.`,
    );
  }
  if (conversationId !== null && !knownHistory) {
    // A conversation resumed from Antigravity's own store was never written by this plugin, so
    // there is nothing to replay. The history is not lost: the CLI still holds it.
    emitNotice(
      session,
      emit,
      "history-unavailable",
      "info",
      "Earlier history is not shown",
      "This conversation already existed in Antigravity, so its earlier turns are not part of Paseo's timeline and are not replayed. Antigravity still has them, and the next reply continues the conversation.",
    );
  }
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    emitNotice(
      session,
      emit,
      "system-prompt-preamble",
      "info",
      "System prompt sent as a preamble",
      "Antigravity has no system-prompt flag, so it is prepended to the first message of the conversation.",
    );
  }

  if (input.history === "replay" && session.transcript) {
    // A child's rows are replayed with the row that spawned it, before the parent announces
    // itself ready: a child session that arrived afterwards would be attached to a row the
    // client had already drawn.
    for (const item of session.transcript.list()) {
      await replayItem(session, emit, item);
    }
  }

  emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

/** What a stored row knows about the child it spawned, as `refreshSubagentRow` wrote it. */
function readSubagentInfo(item: ProviderTimelineItem): SubagentInfo | null {
  if (item.type !== "tool_call") return null;
  const subagent = item.metadata?.subagent;
  if (typeof subagent !== "object" || subagent === null || Array.isArray(subagent)) return null;
  const record = subagent as Record<string, JsonValue>;
  return {
    index: typeof record.index === "number" ? record.index : 0,
    ...(typeof record.conversationId === "string" ? { conversationId: record.conversationId } : {}),
    ...(typeof record.logUri === "string" ? { logUri: record.logUri } : {}),
    ...(typeof record.typeName === "string" ? { typeName: record.typeName } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
    ...(record.done === true ? { done: true } : {}),
  };
}

/** Where a stored row is replayed to: the session holding it, and that session's follow if any. */
interface ReplayHost {
  readonly sessionId: string;
  /** Null for the conversation itself, and for a child that is not being followed any more. */
  readonly follow: ChildFollow | null;
}

/**
 * Republishes one stored row, and with it the child session the row spawned.
 *
 * A stored subagent row names the conversation its child ran in, and the child's own rows were
 * stored under that conversation. They are replayed under the id *this* parent session gives the
 * child, and the id is derived from the parent's — which changes with every session — so the row
 * client draws and the child it links to always agree.
 */
async function replayItem(
  session: Session,
  emit: Emit,
  item: ProviderTimelineItem,
  host: ReplayHost = { sessionId: session.sessionId, follow: null },
): Promise<void> {
  const info = readSubagentInfo(item);
  if (item.type !== "tool_call" || info === null || info.conversationId === undefined) {
    emit({ type: "timeline.item", sessionId: host.sessionId, item });
    return;
  }
  try {
    await replaySubagentItem(session, emit, item, { ...info, conversationId: info.conversationId }, host);
  } catch (error) {
    // Replaying a child is best-effort like everything else of B: failing `session.open` over it
    // would be worse than opening without the child.
    console.error(
      `[antigravity] could not replay the subagent ${info.conversationId}: ${describe(error)}`,
    );
  }
}

async function replaySubagentItem(
  session: Session,
  emit: Emit,
  item: Extract<ProviderTimelineItem, { type: "tool_call" }>,
  info: SubagentInfo & { conversationId: string },
  host: ReplayHost,
): Promise<void> {
  // The child's rows were stored under the child's own conversation, which is what the row's
  // metadata names; a subagent row whose child kept nothing is replayed without a link, since the
  // id the stored link holds belongs to a parent session that no longer exists.
  const stored = await TranscriptStore.load(info.conversationId);
  const childItems = stored.list();
  const childId = childSessionId(session.sessionId, info.conversationId);
  const detail = item.detail.type === "sub_agent" ? item.detail : null;
  const row: SubagentRow = {
    id: item.id,
    callId: item.callId,
    name: item.name,
    detail: detail ?? { type: "sub_agent", log: "" },
    metadata: {},
    turnId: null,
    host: host.follow,
    stepIndex: typeof item.metadata?.stepIndex === "number" ? item.metadata.stepIndex : 0,
    info,
    log: detail?.log ?? info.prompt ?? "",
    ...(detail?.actions !== undefined ? { actions: [...detail.actions] } : {}),
    status: item.status,
    error: item.status === "failed" ? item.error : null,
    childSessionId: childItems.length > 0 ? childId : null,
    published: null,
  };
  refreshSubagentRow(row);
  // Kept even when the child is over: a child that is still going re-renders every row it ever
  // started, and a row that is already known is not started a second time.
  session.subagents.set(row.id, row);
  // Published with `emit`, not `publish`: replaying a row must not write it again, which would
  // move it to the end of the store and reorder the rows of the next replay.
  const rendered = subagentItem(row);
  row.published = JSON.stringify(rendered);
  emit({ type: "timeline.item", sessionId: host.sessionId, item: rendered });
  if (childItems.length === 0) return;

  emit({
    type: "session.opened",
    sessionId: childId,
    parentSessionId: host.sessionId,
    toolCallId: row.id,
    capabilities: [],
    restoration: "parent",
    title: row.info.role ?? row.info.typeName ?? "Subagent",
    description: (row.info.prompt ?? "").slice(0, DESCRIPTION_LIMIT),
    // The directory the child's own transcript was read in, which `replaySubagentItem` resumes.
    cwd: resolveChildCwd(session.config.cwd, info.workspaceUris),
  });
  emit({ type: "session.ready", sessionId: childId });
  emit({
    type: "session.turn",
    sessionId: childId,
    turnId: childTurnId(info.conversationId),
    state: "started",
  });

  // A child that never finished is followed on, when its transcript is still there to follow. The
  // follow exists before the child's rows are replayed because the subagents *it* started are
  // replayed with them, and are hosted by it.
  const path = info.done === true || info.logUri === undefined ? null : transcriptFilePath(info.logUri);
  const followable =
    path !== null &&
    existsSync(path) &&
    !session.closing &&
    (host.follow !== null || host.sessionId === session.sessionId);
  const follow = followable
    ? createChildFollow(session, emit, row, info.conversationId, info.logUri ?? "", info.workspaceUris, stored, true)
    : null;
  for (const child of childItems) {
    await replayItem(session, emit, child, { sessionId: childId, follow });
  }
  if (info.done === true) {
    // The child had already finished when it was stored, so its session is closed with its turn:
    // a child the host still counts as live is one it reports as failed on the next reload.
    emit({
      type: "session.turn",
      sessionId: childId,
      turnId: childTurnId(info.conversationId),
      state: "completed",
    });
    emit({ type: "session.closed", sessionId: childId });
    return;
  }
  if (session.closing) return;
  if (follow === null) {
    // Nothing left to follow, and a child cannot stay open forever: it ends where its stored rows
    // do, with the reason it can go no further.
    emit({
      type: "session.closed",
      sessionId: childId,
      error: { message: "The subagent's transcript is no longer available" },
    });
    return;
  }
  // The rows it holds are the ones just published, so a later read only adds to them. Followed
  // from here on, so the parent's own close still covers it if it never finishes.
  session.childSessions.add(childId);
  registerFollow(session, follow);
  follow.transcript.start();
}

/**
 * Creates the folder attached images are written to. It is passed to every launch, so a session
 * that cannot create it still opens: plain turns run without the extra directory, and an image
 * prompt fails with `attachment_failed`.
 */
async function prepareAttachmentsDir(sessionId: string): Promise<string | null> {
  const dir = attachmentsDir(sessionId);
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch (error) {
    console.error(`[antigravity] could not create ${dir}: ${describe(error)}`);
    return null;
  }
}

/**
 * Makes the workspace's `.agents/mcp_config.json` hold this session's servers exactly when the
 * sharing toggle is on. agy reads that file at startup, so this runs on the way to a launch: at
 * `session.open`, and at the start of a turn whose process is being replaced (the relaunch the
 * toggle raises). A failed attempt is reported once and left until the toggle is switched off and
 * on again, rather than re-reported on every turn.
 */
async function syncSessionMcp(session: Session, emit: Emit): Promise<void> {
  const servers = session.config.mcpServers;
  if (!isSettingOn(session.settings.shareMcp) || Object.keys(servers).length === 0) {
    if (session.mcp === "released") return;
    session.mcp = "released";
    await releaseMcpServers(session.sessionId);
    return;
  }
  if (session.mcp !== "released") return;

  const result = await injectMcpServers({
    cwd: session.config.cwd,
    sessionId: session.sessionId,
    servers,
  });
  if (result.status === "invalid") {
    session.mcp = "error";
    emitNotice(
      session,
      emit,
      "mcp-config-invalid",
      "warning",
      "Paseo tools were not shared",
      `${result.path} exists but is not valid JSON, so it was left untouched. Fix or remove it, then turn sharing off and on again.`,
    );
    return;
  }
  if (result.status === "failed") {
    session.mcp = "error";
    emitNotice(
      session,
      emit,
      "mcp-config-failed",
      "warning",
      "Paseo tools were not shared",
      `${result.path} could not be written: ${result.message}`,
    );
    return;
  }
  session.mcp = "applied";
  if (result.status === "unchanged") return;
  emitNotice(
    session,
    emit,
    "mcp-shared",
    "warning",
    "Paseo tools are shared with Antigravity",
    `Antigravity loads Paseo's MCP servers from ${result.path}. That file holds the credentials those servers use (HTTP headers, or environment variables for stdio servers), so the plugin adds it to this repository's local git exclude — invisible to anyone else, and removed with the entries when the last Paseo session here closes. Outside a git work tree, keep .agents/mcp_config.json out of version control yourself.`,
  );
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const { prompt } = input;

  // Which command the user picked decides the launch, so the list is read again here rather than
  // trusted from `session.open`: a skill may have been installed, removed, or renamed since.
  const command = prompt.input.type === "command" ? prompt.input : null;
  const discovered = command === null ? null : await discoverCommands(session.config.cwd);
  const skill = command === null ? null : (discovered?.expanded.get(command.name) ?? null);
  const unlisted =
    command !== null &&
    discovered !== null &&
    !discovered.commands.some((entry) => entry.name === command.name);
  // The composer offered this name as one this plugin expands, and the roots no longer have it:
  // sending `/<name>` would only get the model answering the literal text.
  if (skill === null && command !== null && unlisted && session.publishedSkills.has(command.name)) {
    failPrompt(session, emit, prompt.clientMessageId, {
      message: `The skill "${command.name}" is no longer installed where this plugin expands skills from (~/.agents/skills). Reinstall it, or reopen the session if it was just added.`,
      code: "skill_unavailable",
    });
    return;
  }
  // `/plan` is never the CLI's own: its workflow approves its own plan review in a headless run
  // and implements in the same turn (observed 2026-09-29: "The user has automatically approved the
  // artifact through their review policy. Proceed to execution."). It becomes a plan-mode turn of
  // the plugin's instead — the preamble and the plan card — whatever mode the session is in.
  const planCommand = command !== null && skill === null && command.name === PLAN_COMMAND;
  const profile: LaunchProfile = {
    schema: prompt.outputSchema !== undefined,
    // A plugin-expanded skill never reaches the CLI as a slash name, so it needs no expansion —
    // and must not have it, or a body containing `/...` could be parsed as a command.
    commands: command !== null && skill === null && !planCommand,
    skillDir: skill?.dir ?? null,
  };
  // `--json-schema`, `--add-dir` and `--disable-slash-commands` belong to the process, not the
  // turn, and the CLI cannot be replaced while it still owes a turn — so a prompt whose profile
  // the running CLI cannot serve is refused rather than queued into it.
  const refusal = queuedRefusal(session, profile);
  if (refusal !== null) {
    failPrompt(session, emit, prompt.clientMessageId, { message: refusal, code: "busy" });
    return;
  }

  // Read before the turn is announced: a skill that vanished since the picker was filled fails
  // the prompt instead of starting a turn the CLI cannot answer.
  let expanded: string | null = null;
  if (command !== null && skill !== null) {
    const rendered = await renderSkillPrompt(skill, command.arguments.trim());
    if (rendered.kind !== "text") {
      failPrompt(session, emit, prompt.clientMessageId, {
        message:
          rendered.kind === "too_large"
            ? `${skill.path} is ${rendered.bytes} bytes, and this plugin sends at most ${MAX_SKILL_BYTES / 1024} KiB of a skill it expands itself. Install the skill for Antigravity itself (see the README) or shorten it.`
            : `The skill "${skill.name}" could not be read: ${rendered.message}. Reinstall it, or run \`/skills reload\` in Antigravity if it was just installed.`,
        code: rendered.kind === "too_large" ? "skill_too_large" : "skill_unavailable",
      });
      return;
    }
    expanded = rendered.text;
  }

  if (profile.schema) {
    try {
      await mkdir(dirname(session.schemaPath), { recursive: true });
      await writeFile(session.schemaPath, JSON.stringify(prompt.outputSchema), "utf8");
    } catch (error) {
      failPrompt(session, emit, prompt.clientMessageId, {
        message: `Could not write the output schema for Antigravity: ${describe(error)}`,
        code: "schema_failed",
      });
      return;
    }
  }
  session.launchPending = profile;

  // A schema prompt always gets a fresh CLI (the file it read may have changed since), and any
  // prompt that needs the other profile must not be served by the process running now.
  const sameLaunch =
    session.launchActive.schema === profile.schema &&
    session.launchActive.commands === profile.commands &&
    session.launchActive.skillDir === profile.skillDir;
  if (session.process?.running && (!sameLaunch || profile.schema)) session.needsRestart = true;
  await releaseDetached(session);
  await applyPendingRestart(session);
  // The CLI reads the workspace MCP config at startup and only this path spawns one, so a toggle
  // change lands here; a turn queued behind a running one waits for its own relaunch instead.
  if (session.pendingTurns.length === 0) await syncSessionMcp(session, emit);
  // Typing a new message instead of answering the plan prompt is the user choosing to keep
  // planning, so the prompt is withdrawn rather than left to answer a plan that moved on.
  resolvePendingPlan(session, emit);
  // The same holds for a question: the message is the user's answer, in their own words.
  resolvePendingQuestion(session, emit);

  // What the timeline shows the user typed, and what the CLI is actually sent. A native command
  // is expanded by the CLI, so both are the same `/<name> <arguments>`; a plugin-expanded skill is
  // sent as the skill's own instructions, while the row still reads the command that was picked.
  let typed = "";
  let text = "";
  if (command !== null) {
    const args = command.arguments.trim();
    // The leading `/name` is what the CLI expands, so it goes out as the first token of the turn.
    typed = args.length > 0 ? `/${command.name} ${args}` : `/${command.name}`;
    text = planCommand ? args : (expanded ?? typed);
  } else if (prompt.input.type === "message") {
    try {
      text = await renderPromptContent(session, prompt.input.content);
    } catch (error) {
      failPrompt(session, emit, prompt.clientMessageId, {
        message: `Could not attach the prompt's image: ${describe(error)}`,
        code: "attachment_failed",
      });
      return;
    }
  }
  if (text.trim().length === 0) {
    failPrompt(session, emit, prompt.clientMessageId, {
      message: "Antigravity requires a non-empty text prompt",
      code: "empty_prompt",
    });
    return;
  }

  // The CLI expands `/name` only as the first token of a turn, so nothing may be put before a
  // command the CLI expands itself.
  const verbatim = command !== null && expanded === null && !planCommand;
  await startTurn(session, emit, {
    shown: typed.length > 0 ? typed : text,
    text,
    clientMessageId: prompt.clientMessageId,
    verbatim,
    plan: planCommand || (session.selection.mode === PLAN_MODE_ID && !verbatim),
  });
}

interface TurnRequest {
  /** What the timeline shows the user sent. */
  shown: string;
  /** What the CLI is sent, before the system prompt and plan-mode preambles. */
  text: string;
  /** Absent for a turn the plugin starts itself, such as implementing an approved plan. */
  clientMessageId?: string;
  /** Written exactly as given: no system prompt and no plan-mode preamble in front of it. */
  verbatim: boolean;
  /** A plan-mode turn: the preamble goes in front of the text and its answer is offered as a plan. */
  plan: boolean;
}

async function startTurn(session: Session, emit: Emit, request: TurnRequest): Promise<void> {
  session.turnCounter += 1;
  const plan = request.plan;
  const turn: PendingTurn = {
    turnId: `turn-${session.turnCounter}-${randomUUID().slice(0, 8)}`,
    assistant: new Map(),
    tools: new Map(),
    snapshots: new Map(),
    hadAssistantText: false,
    // Replaced below with the launch profile of the process that actually serves the turn: a turn
    // queued behind another is answered by that process, not by the one its own prompt implies.
    schema: false,
    lastStreamStep: -1,
    backfilled: new Map(),
    backfill: null,
    backfillTimer: null,
    outgoing: "",
    plan,
  };

  publish(session, emit, {
    type: "user_message",
    id: `user:${turn.turnId}`,
    text: request.shown,
    ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}),
  });
  if (request.clientMessageId !== undefined) {
    emit({
      type: "session.prompt_result",
      sessionId: session.sessionId,
      clientMessageId: request.clientMessageId,
      result: { type: "turn", turnId: turn.turnId },
    });
  }
  emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "started" });

  if (request.verbatim) {
    // The system prompt's preamble waits for the first plain message.
    turn.outgoing = request.text;
  } else {
    turn.outgoing = buildOutgoingText(session, plan ? `${PLAN_MODE_PREAMBLE}\n\n${request.text}` : request.text);
    session.systemPromptSent = true;
  }
  await writePendingTurn(session, emit, turn);
}

/** Hands a turn to the CLI, or fails it when no CLI can take it. */
async function writePendingTurn(session: Session, emit: Emit, turn: PendingTurn): Promise<void> {
  try {
    // Picking the process first: replacing a CLI whose stdin died settles the turns that CLI still
    // owed, and this turn must not be counted among them.
    const process = ensureProcess(session, emit);
    turn.schema = session.launchActive.schema;
    session.pendingTurns.push(turn);
    await process.writeTurn(turn.outgoing);
  } catch (error) {
    session.pendingTurns = session.pendingTurns.filter((pending) => pending !== turn);
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: "failed",
      error: { message: describe(error), code: "agy_launch_failed" },
    });
  }
}

/**
 * Why a prompt cannot be queued behind the turn already running, or null when it can. agy serves
 * every turn of a process with that process's launch flags, so a prompt that needs the other
 * profile would be answered under the wrong ones, and the CLI cannot be replaced until the turn it
 * still owes has finished.
 */
function queuedRefusal(session: Session, profile: LaunchProfile): string | null {
  if (session.pendingTurns.length === 0) return null;
  if (profile.schema) {
    return "Antigravity applies a structured-output schema to the whole process, so this prompt cannot be queued behind a running turn. Wait for the turn to finish and send it again.";
  }
  if (profile.commands) {
    return "Antigravity expands slash commands only on a CLI launched without --disable-slash-commands, and that CLI cannot be replaced while it is still answering. Wait for the turn to finish and send the command again.";
  }
  if (profile.skillDir !== null) {
    return "This skill is expanded by the plugin, which gives the CLI the skill's own directory for that turn alone, and the CLI cannot be replaced while it is still answering. Wait for the turn to finish and send the command again.";
  }
  if (session.launchActive.schema) {
    return "Antigravity is answering a structured-output request, and applies its schema to every turn of that process. Wait for the turn to finish and send this again.";
  }
  if (session.launchActive.commands) {
    return "Antigravity is running a slash command on a CLI launched without --disable-slash-commands, so a plain message could be expanded as a command instead of answered. Wait for the turn to finish and send it again.";
  }
  if (session.launchActive.skillDir !== null) {
    return "Antigravity is running a turn that was given an extra skill directory, and that CLI cannot be replaced while it is still answering. Wait for the turn to finish and send this again.";
  }
  return null;
}

async function interruptSession(
  input: Extract<ProviderInput, { type: "session.interrupt" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const process = session.process;
  if (process?.running) {
    session.interrupting = true;
    try {
      await process.interrupt();
    } finally {
      session.interrupting = false;
    }
  }
  // agy normally reports `result.error = "interrupted"` before exiting, which resolves the turn.
  // If it died without one, the exit handler cancels whatever is still pending.
  emit({ type: "request.completed", requestId: input.requestId });
}

async function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const changes = input.changes;

  if (changes.model !== undefined) {
    session.selection.model = changes.model === null ? undefined : changes.model;
  }
  if (changes.mode !== undefined) {
    session.selection.mode = changes.mode === null ? undefined : changes.mode;
  }
  if (changes.thinkingOption !== undefined) {
    session.selection.thinkingOption =
      changes.thinkingOption === null ? undefined : changes.thinkingOption;
  }
  if (changes.settings) {
    session.settings = { ...session.settings, ...changes.settings };
  }

  // A newly selected model may be the one the provider option's effort belongs to, and a newly
  // selected tier wins over it; either way the committed config below has to carry the winner.
  applyProviderEffort(session);

  // agy fixes the model, mode, and approval flags at launch, so a change is applied by restarting
  // the CLI. That restart is deferred to the start of the next turn: killing the process here
  // would abort an answer that is already streaming just because a selector moved.
  if (session.process?.running) session.needsRestart = true;

  emit({ type: "session.config", sessionId: session.sessionId, config: configState(session) });
  emit({ type: "request.completed", requestId: input.requestId });
}

/**
 * Restarts the CLI so newly selected launch flags take effect. The Antigravity conversation id is
 * passed back through `--conversation`, so the history survives the restart.
 */
async function applyPendingRestart(session: Session): Promise<void> {
  if (!session.needsRestart || session.pendingTurns.length > 0) return;
  session.needsRestart = false;

  const process = session.process;
  if (!process) return;
  session.process = null;
  console.log("[antigravity] restarting the CLI with updated settings");
  await process.dispose();
}

/**
 * Takes the CLI left holding a background task out of the session and stops watching it. The
 * caller disposes the process that is returned.
 */
function takeDetached(session: Session): AgyProcess | null {
  const detached = session.detached;
  if (!detached) return null;
  session.detached = null;
  detached.watch.stop();
  return detached.process;
}

/** Disposes the CLI left holding a background task, so a fresh one serves the next turn. */
async function releaseDetached(session: Session): Promise<void> {
  const detached = takeDetached(session);
  if (!detached) return;
  console.log("[antigravity] stopping the CLI that was still holding a background task");
  await detached.dispose();
}

/**
 * Starts reading the conversation transcript once a tool has been ACTIVE for a while, because a
 * command agy moved to the background holds the rest of the stream back (see `backfill.ts`).
 */
function scheduleBackfill(session: Session, turn: PendingTurn, emit: Emit): void {
  if (turn.backfill || turn.backfillTimer) return;
  // The tests shorten the wait; nothing else sets this.
  const delay = Number(process.env.PASEO_ANTIGRAVITY_BACKFILL_DELAY_MS) || BACKFILL_DELAY_MS;
  turn.backfillTimer = setTimeout(() => {
    turn.backfillTimer = null;
    const conversationId = session.conversationId;
    // The tool reported back in time, or the turn is already over: nothing is held.
    if (session.closing || session.pendingTurns[0] !== turn || turn.tools.size === 0) return;
    if (conversationId === null) return;
    console.log(
      `[antigravity] a tool has been running for ${delay / 1000}s; following the conversation transcript`,
    );
    turn.backfill = new TranscriptPoller(
      conversationTranscriptPath(accountGeminiRoot(session.accountId), conversationId),
      (entries) => applyBackfill(session, turn, entries, emit),
    );
    turn.backfill.start();
  }, delay);
  turn.backfillTimer.unref();
}

function stopBackfill(turn: PendingTurn): void {
  if (turn.backfillTimer) clearTimeout(turn.backfillTimer);
  turn.backfillTimer = null;
  turn.backfill?.stop();
  turn.backfill = null;
}

/**
 * Publishes the steps the transcript holds and the stream has not delivered, and settles the turn
 * once the transcript shows its final answer. A step the stream already delivered stays the
 * stream's; a step published here stays this function's, whatever the stream sends later.
 */
function applyBackfill(
  session: Session,
  turn: PendingTurn,
  entries: Parameters<typeof renderBackfill>[0],
  emit: Emit,
): void {
  if (session.closing || session.pendingTurns[0] !== turn) {
    stopBackfill(turn);
    return;
  }
  const render = renderBackfill(
    entries,
    {
      message: (stepIndex) => itemId(turn, stepIndex, "msg"),
      tool: (stepIndex) => itemId(turn, stepIndex, "tool"),
    },
    session.config.cwd,
  );
  for (const { stepIndex, item } of render.rows) {
    if (stepIndex <= turn.lastStreamStep && !turn.backfilled.has(stepIndex)) continue;
    const json = JSON.stringify(item);
    if (turn.backfilled.get(stepIndex) === json) continue;
    turn.backfilled.set(stepIndex, json);
    if (item.type === "tool_call") {
      if (item.status === "running") {
        turn.tools.set(item.callId, {
          id: item.id,
          callId: item.callId,
          name: item.name,
          detail: item.detail,
          metadata: { ...item.metadata },
        });
      } else {
        turn.tools.delete(item.callId);
      }
    } else if (item.type === "assistant_message") {
      turn.assistant.set(stepIndex, item.text);
      turn.hadAssistantText = true;
    }
    publish(session, emit, item);
  }
  if (render.finalStep !== null && turn.backfilled.has(render.finalStep)) {
    settleFromTranscript(session, turn, render.finalStep, emit);
  }
}

/**
 * Completes a turn whose answer only the transcript has. The CLI serving it still owes that turn's
 * `result`, and will not read another line until its background task ends, so it is detached:
 * nothing it prints is used any more, and a fresh CLI resumes the conversation for the next turn.
 * Its transcript stays watched past `finalStep`, the settled answer (see `stopIfResumed`).
 */
function settleFromTranscript(session: Session, turn: PendingTurn, finalStep: number, emit: Emit): void {
  stopBackfill(turn);
  const queued = session.pendingTurns.filter((pending) => pending !== turn);
  session.pendingTurns = [];
  console.log(
    `[antigravity] settled ${turn.turnId} from the conversation transcript; the CLI is still held by a background task`,
  );
  finalizeToolCalls(session, emit, turn, { status: "completed" });
  emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "completed" });
  offerPlan(session, emit, turn, lastAssistantText(turn));

  const stuck = session.process;
  session.process = null;
  const previous = takeDetached(session);
  if (previous) void previous.dispose();
  const conversationId = session.conversationId;
  if (stuck && conversationId !== null) {
    const detached: DetachedCli = {
      process: stuck,
      watch: new TranscriptPoller(
        conversationTranscriptPath(accountGeminiRoot(session.accountId), conversationId),
        (entries) => stopIfResumed(session, detached, finalStep, entries, emit),
      ),
    };
    session.detached = detached;
    detached.watch.start();
  } else if (stuck) {
    // Unreachable — the transcript that settled the turn is the conversation's — but a CLI nobody
    // watches must not be left running.
    void stuck.dispose();
  }
  emitNotice(
    session,
    emit,
    "agy-background-task",
    "info",
    "A background command is still running",
    "Antigravity left a command running in the background (for example a dev server) after its answer. It keeps running until your next message, which resumes this conversation in a fresh Antigravity CLI and stops it. If Antigravity starts working again on its own before that, it is stopped.",
  );
  // Turns written behind the settled one were queued inside the detached CLI and would never run
  // there, so they go to the fresh one instead. Their `started` was already announced.
  if (queued.length > 0) void resendQueued(session, emit, queued);
}

async function resendQueued(session: Session, emit: Emit, queued: readonly PendingTurn[]): Promise<void> {
  await releaseDetached(session);
  for (const turn of queued) await writePendingTurn(session, emit, turn);
}

/**
 * Stops a detached CLI whose conversation moved past the answer its turn was settled with. That
 * is agy carrying the settled turn on by itself — typically handed a background task's result
 * when the task ended — and nothing it does from there would be seen: its stream is no longer
 * read. Observed 2026-09-29: after "I will continue as soon as initialization completes", the
 * detached CLI built an entire app and started its dev server. Nothing may run without the user's
 * next message, so the CLI is stopped, and that message resumes the conversation in a fresh one.
 */
function stopIfResumed(
  session: Session,
  detached: DetachedCli,
  finalStep: number,
  entries: readonly { stepIndex: number }[],
  emit: Emit,
): void {
  if (session.closing || session.detached !== detached) return;
  if (!entries.some((entry) => entry.stepIndex > finalStep)) return;
  takeDetached(session);
  console.log(
    `[antigravity] the detached CLI's conversation moved past step ${finalStep} on its own; stopping it`,
  );
  void detached.process.dispose();
  emitNotice(
    session,
    emit,
    "agy-background-resumed",
    "warning",
    "Antigravity was stopped",
    "Antigravity started working again on its own after its answer, usually because a background command it was waiting for finished. The plugin stopped it, and its background commands with it, so nothing runs without your say. Send a message, such as \"continue\", to resume the conversation.",
  );
}

/** The turn's last assistant text: what a plan-mode turn offers as its plan. */
function lastAssistantText(turn: PendingTurn): string {
  let last = -1;
  for (const stepIndex of turn.assistant.keys()) last = Math.max(last, stepIndex);
  return last === -1 ? "" : (turn.assistant.get(last) ?? "");
}

/** Asks the user to implement the plan a plan-mode turn ended with. */
function offerPlan(session: Session, emit: Emit, turn: PendingTurn, text: string): void {
  if (!session.planApproval || !turn.plan || text.trim().length === 0) return;
  resolvePendingPlan(session, emit);
  const id = `plan:${turn.turnId}`;
  session.pendingPlan = { id, text };
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
        { id: "implement", label: "Implement", behavior: "allow", variant: "primary", intent: "implement" },
        { id: "dismiss", label: "Keep planning", behavior: "deny", variant: "secondary", intent: "dismiss" },
      ],
    },
  });
}

/** Withdraws the plan prompt, if one is open. */
function resolvePendingPlan(session: Session, emit: Emit): void {
  const plan = session.pendingPlan;
  if (!plan) return;
  session.pendingPlan = null;
  emit({ type: "session.permission_resolved", sessionId: session.sessionId, permissionId: plan.id });
}

/** Withdraws the question card, if one is open, and marks its row dismissed. */
function resolvePendingQuestion(session: Session, emit: Emit): void {
  const question = session.pendingQuestion;
  if (!question) return;
  session.pendingQuestion = null;
  publish(session, emit, questionRow(question.callId, question.questions, { kind: "dismissed" }));
  emit({ type: "session.permission_resolved", sessionId: session.sessionId, permissionId: question.id });
}

/**
 * Checks whether the `unknown` step at `callStep` is an `ask_question` call that agy answered with
 * "User Skipped", and if so stops the turn and asks the user instead. Headless agy cannot show the
 * question, and the stream carries nothing but the step type, so the conversation transcript is
 * the only place the question can be read from.
 */
async function relaySkippedQuestion(
  session: Session,
  turn: PendingTurn,
  callStep: number,
  emit: Emit,
): Promise<void> {
  // A schema turn must end in the decoded answer, and without `permission` there is no card to
  // show; agy settles the question itself in both, as it always did.
  if (!session.planApproval || turn.schema || session.conversationId === null) return;
  const path = conversationTranscriptPath(accountGeminiRoot(session.accountId), session.conversationId);
  let skipped: SkippedQuestion | null = null;
  let seen = false;
  for (let attempt = 0; attempt < QUESTION_READ_ATTEMPTS && !seen; attempt += 1) {
    if (attempt > 0) await sleep(QUESTION_READ_RETRY_MS);
    const text = await readFile(path, "utf8").catch(() => "");
    const { entries } = parseTranscriptLines(text);
    seen = entries.some((entry) => entry.stepIndex === callStep);
    if (seen) skipped = findSkippedQuestion(entries, callStep);
  }
  if (!seen) {
    console.error(`[antigravity] step ${callStep} never reached ${path}; not checking it for a question`);
    return;
  }
  // The turn may have ended, or been replaced, while the file was read.
  if (skipped === null || session.closing || session.pendingTurns[0] !== turn) return;
  stopForQuestion(session, turn, skipped, emit);
}

/**
 * Stops the CLI before the model acts on "User Skipped" and completes the turn: the stop is the
 * plugin's, not the user's, so the turn is not reported as interrupted. The process is detached
 * first, which leaves its interrupted result and its exit to no turn at all. The next turn resumes
 * the conversation in a fresh CLI.
 */
function stopForQuestion(session: Session, turn: PendingTurn, skipped: SkippedQuestion, emit: Emit): void {
  const stopped = session.process;
  session.process = null;
  void stopped?.interrupt();
  stopBackfill(turn);
  const queued = session.pendingTurns.slice(1);
  session.pendingTurns = [];
  console.log(
    `[antigravity] stopped ${turn.turnId} at step ${skipped.callStep}: agy skipped ${skipped.questions.length} question(s)`,
  );

  finalizeToolCalls(session, emit, turn, { status: "completed" });
  emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "completed" });
  const callId = itemId(turn, skipped.callStep, "tool");
  if (queued.length > 0) {
    // A message the user sent while the turn ran already moved the conversation on, so it goes to
    // the fresh CLI and the question is not asked. Their `started` was already announced.
    publish(session, emit, questionRow(callId, skipped.questions, { kind: "dismissed" }));
    void resendQueued(session, emit, queued);
    return;
  }
  publish(session, emit, questionRow(callId, skipped.questions, { kind: "pending" }));
  const id = `question:${turn.turnId}:${skipped.callStep}`;
  session.pendingQuestion = { id, callId, questions: skipped.questions, plan: turn.plan };
  emit({ type: "session.permission", sessionId: session.sessionId, request: questionRequest(id, skipped.questions) });
}

/**
 * The user's reply to a question card. An answer goes back as the next turn, on a plain launch
 * whatever launched the turn that asked: `/teamwork-preview`'s answer is a message, not a command.
 * A dismissal sends nothing; the model already holds "User Skipped" and the user types next.
 */
async function answerQuestion(
  session: Session,
  response: Extract<ProviderInput, { type: "session.permission" }>["response"],
  emit: Emit,
): Promise<void> {
  const question = session.pendingQuestion;
  if (!question) return;
  if (response.behavior !== "allow") {
    resolvePendingQuestion(session, emit);
    return;
  }
  session.pendingQuestion = null;
  emit({ type: "session.permission_resolved", sessionId: session.sessionId, permissionId: question.id });
  const answers = readAnswers(question.questions, response);
  publish(session, emit, questionRow(question.callId, question.questions, { kind: "answered", answers }));

  session.launchPending = { schema: false, commands: false, skillDir: null };
  await releaseDetached(session);
  await startTurn(session, emit, {
    shown: answerShown(question.questions, answers),
    text: answerPrompt(question.questions, answers),
    verbatim: false,
    // An answer is a plain message, so plan mode makes it a plan turn like any other.
    plan: question.plan || session.selection.mode === PLAN_MODE_ID,
  });
}

/**
 * The user's answer to a plan prompt or a question card. Approving a plan sent in plan mode leaves
 * it for `accept-edits` — plan mode would only have the model plan again — while a `/plan` turn's
 * plan is implemented in the mode the session already had. Either way the turn that implements
 * the plan follows.
 */
async function respondToPermission(
  input: Extract<ProviderInput, { type: "session.permission" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  if (session.pendingQuestion?.id === input.permissionId) {
    await answerQuestion(session, input.response, emit);
    return;
  }
  const plan = session.pendingPlan;
  if (!plan || plan.id !== input.permissionId) {
    console.error(`[antigravity] ignoring an answer to unknown permission ${input.permissionId}`);
    emit({ type: "session.permission_resolved", sessionId: session.sessionId, permissionId: input.permissionId });
    return;
  }
  resolvePendingPlan(session, emit);
  if (input.response.behavior !== "allow") return;

  if (session.selection.mode === PLAN_MODE_ID) {
    session.selection.mode = IMPLEMENT_MODE_ID;
    emit({ type: "session.config", sessionId: session.sessionId, config: configState(session) });
  }
  // The mode is a launch flag, and the implementing turn is a plain message.
  session.launchPending = { schema: false, commands: false, skillDir: null };
  if (session.process?.running) session.needsRestart = true;
  await releaseDetached(session);
  await applyPendingRestart(session);
  await startTurn(session, emit, {
    shown: IMPLEMENT_PLAN_TEXT,
    text: IMPLEMENT_PLAN_TEXT,
    verbatim: false,
    plan: false,
  });
}

async function closeSession(
  input: Extract<ProviderInput, { type: "session.close" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  session.closing = true;
  const process = session.process;
  session.process = null;
  const detached = takeDetached(session);
  for (const turn of session.pendingTurns) stopBackfill(turn);
  // Before the timeline is flushed, so the question's row is stored as dismissed.
  resolvePendingQuestion(session, emit);
  state.sessions.delete(input.sessionId);

  // Children first — those being followed and those a replay re-opened with no tailer behind them
  // — and all of them before the parent's `session.closed`: nothing may be published for a child
  // once its session is closed. Stopping the tailers before the awaits below is what makes that
  // true even if a transcript is being written right now.
  const children = [...session.follows.values()];
  session.follows.clear();
  for (const follow of children) follow.transcript.stop();

  await session.transcript?.flush();
  for (const follow of children) await follow.store?.flush();
  await rm(session.schemaPath, { force: true });
  await clearAttachments(session.sessionId);
  await releaseMcpServers(session.sessionId);
  if (process) await process.dispose();
  if (detached) await detached.dispose();

  // Every child that settled already closed its own session and left this set, so what is left is
  // a child that was still running: closing it silently would tell the host it completed.
  for (const childId of session.childSessions) {
    emit({
      type: "session.closed",
      sessionId: childId,
      error: { message: "The session was closed before the subagent finished" },
    });
  }
  session.childSessions.clear();
  emit({ type: "session.closed", sessionId: input.sessionId });
  emit({ type: "request.completed", requestId: input.requestId });
}

function ensureProcess(session: Session, emit: Emit): AgyProcess {
  const current = session.process;
  if (current?.running) {
    if (current.acceptsInput) return current;
    // A CLI that lost its stdin can neither take this turn nor finish the ones it still owes, so
    // settle those turns and replace it. Its own exit is ignored below: it no longer owns the
    // session, and failing the new process's turns from it would be wrong.
    handleAgyExit(session, { code: null, signal: null }, emit);
    void current.dispose();
  }

  // Resolved first: the provider option's effort may be what supplies the tier the slug carries.
  const effort = applyProviderEffort(session);
  const thinking = resolveThinking(
    session.selection.model,
    session.selection.thinkingOption,
    session.accountId,
  );
  // Every launch re-syncs the account's shadow home, so a real entry added — or a link whose
  // target is gone — never survives into the next `agy`. Default has no shadow home and no
  // override: its env is exactly what Paseo configured.
  const home = accountHome(session.accountId);
  if (home !== null) syncShadowHome(session.accountId);
  const process = new AgyProcess(
    {
      cwd: session.config.cwd,
      // After `config.env`, because the account decides where `$HOME/.gemini` resolves even when
      // the user set a HOME of their own in the session's environment.
      env: home === null ? session.config.env : { ...session.config.env, HOME: home },
      model: thinking.slug,
      // Paseo's plan mode is the plugin's preamble, never agy's `--mode plan`: agy leaves that flag
      // without effect while slash-command expansion is disabled, and making it real is worse —
      // probed 2026-09-25, with expansion on the CLI approved its own plan review and implemented
      // in the same turn, preamble or not (fixtures/16-plan-mode.*). The preamble alone planned and
      // stopped, with and without `--dangerously-skip-permissions`.
      mode: session.selection.mode === PLAN_MODE_ID ? undefined : session.selection.mode,
      // Set only when no model is selected: with one, the effort already lives in the slug's tier.
      effort,
      agent: selectedAgent(session),
      conversationId: session.conversationId ?? undefined,
      sandbox: isSettingOn(session.settings.sandbox),
      addDirs: session.addDirs,
      skipPermissions: approvalPolicy(session) === "skip",
      outputSchemaPath: session.launchPending.schema ? session.schemaPath : undefined,
      allowSlashCommands: session.launchPending.commands,
      attachmentDir: session.attachmentsDir ?? undefined,
      skillDir: session.launchPending.skillDir ?? undefined,
      extraArgs: session.extraArgs,
      binary: session.agyPath,
    },
    {
      // A replaced CLI keeps writing events and stderr until it dies; none of it belongs to the
      // turns of the process that replaced it.
      onEvent: (event) => {
        if (session.process !== process) return;
        handleAgyEvent(session, event, emit);
      },
      onStderr: (line) => {
        if (session.process !== process) return;
        session.stderrTail.push(line);
        if (session.stderrTail.length > STDERR_TAIL) session.stderrTail.shift();
        session.agyError = parseAgyErrorLine(line) ?? session.agyError;
        console.error(`[antigravity] ${line}`);
      },
      onExit: (info) => {
        if (session.process !== process) return;
        handleAgyExit(session, info, emit);
      },
    },
  );

  session.process = process;
  // What this launch actually got, so the next prompt can tell whether it needs its own one.
  session.launchActive = session.launchPending;
  // The tail explains *this* process's failure; leftovers from a previous launch would be quoted
  // as if they came from the run that just died. The same holds for the structured error line.
  session.stderrTail = [];
  session.agyError = null;
  process.start();
  return process;
}

function handleAgyEvent(session: Session, event: AgyEvent, emit: Emit): void {
  switch (event.kind) {
    case "init":
      console.log(
        `[antigravity] init conversation=${event.conversationId} tools=${event.tools.length}`,
      );
      if (event.conversationId !== session.conversationId) {
        session.conversationId = event.conversationId;
        // A new conversation starts empty; a resumed one was loaded during session.open.
        session.transcript = session.persist ? new TranscriptStore(event.conversationId) : null;
      }
      if (session.transcript && session.unpersisted.length > 0) {
        // The user's first message is published before the process exists, so it is captured here.
        for (const item of session.unpersisted) session.transcript.upsert(item);
        session.unpersisted = [];
      }
      emit({
        type: "session.persistence",
        sessionId: session.sessionId,
        persistence: persistenceFor(event.conversationId, session.accountId),
      });
      return;
    case "step_update":
      handleStepUpdate(session, event.step, emit);
      return;
    case "result":
      handleResult(session, event.result, emit);
      return;
    default:
      return;
  }
}

function handleStepUpdate(session: Session, step: AgyStepUpdate, emit: Emit): void {
  console.log(
    `[antigravity] step idx=${step.step_index} ${step.state} ${step.step_type}` +
      `${step.text_delta ? ` delta=${step.text_delta.length}` : " (no text)"}` +
      `${step.tool_name ? ` tool=${step.tool_name}` : ""}`,
  );

  const turn = session.pendingTurns[0];
  if (turn) {
    // The transcript already supplied this step while the stream was held; publishing the
    // stream's own copy now would only repeat it, and an assistant row would repeat its text.
    if (turn.backfilled.has(step.step_index)) return;
    if (step.step_index > turn.lastStreamStep) turn.lastStreamStep = step.step_index;
  }

  if (step.step_type === STEP_AGENT_RESPONSE) {
    if (!turn) {
      console.error(
        `[antigravity] dropping an agent_response step that belongs to no pending turn (idx=${step.step_index})`,
      );
      return;
    }
    if (step.text_delta) {
      // text_delta is an incremental chunk, so accumulate to republish complete snapshots.
      turn.assistant.set(
        step.step_index,
        (turn.assistant.get(step.step_index) ?? "") + step.text_delta,
      );
    }
    if (step.usage?.input_tokens !== undefined) turn.contextInputTokens = step.usage.input_tokens;
    const text = turn.assistant.get(step.step_index);
    if (text && text.length > 0) {
      turn.hadAssistantText = true;
      // A schema turn streams nothing to Paseo. Paseo maps every assistant snapshot to a *delta*
      // appended to its message, so a row streamed now and replaced by the decoded JSON on the
      // result would show both texts joined; the buffer is published once instead (`handleResult`,
      // `publishBufferedAnswer`). Tool rows are unaffected: they are not text-merged.
      if (!turn.schema) {
        publish(session, emit, {
          type: "assistant_message",
          id: itemId(turn, step.step_index, "msg"),
          text,
        });
      }
    }
    return;
  }

  // A step is reported twice when it spawns children: first as the `tool` line that called
  // `invoke_subagent`, then as a `subagent` line with the conversations it started. Both describe
  // the same rows, so both come here and merge into whatever the rows already hold.
  if (step.step_type === STEP_SUBAGENT) {
    if (!turn) {
      console.error(
        `[antigravity] dropping a subagent step that belongs to no pending turn (idx=${step.step_index})`,
      );
      return;
    }
    handleSubagentStep(
      session,
      step,
      turn,
      step.tool_name ?? step.tool_info?.name ?? INVOKE_SUBAGENT,
      emit,
    );
    return;
  }

  if (step.step_type === STEP_TOOL) {
    if (!turn) {
      console.error(
        `[antigravity] dropping a tool step that belongs to no pending turn (idx=${step.step_index})`,
      );
      return;
    }
    const name = step.tool_name ?? step.tool_info?.name ?? "tool";
    // `invoke_subagent` is the one tool whose call is not the whole story: the children it spawned
    // keep running after the call reports DONE, so its rows are published and settled elsewhere.
    if (name === INVOKE_SUBAGENT) {
      handleSubagentStep(session, step, turn, name, emit);
      return;
    }
    const callId = itemId(turn, step.step_index, "tool");
    console.log(`[antigravity] tool ${name} ${step.state}`);
    const detail = mapToolDetail(name, step.tool_info, session.config.cwd);
    const tool: OpenToolCall = {
      id: callId,
      callId,
      name,
      detail,
      metadata: {
        stepIndex: step.step_index,
        ...(step.tool_info?.parameters ? { parameters: toJson(step.tool_info.parameters) } : {}),
      },
    };
    // The stream names the file but not the change, so the file itself is the only source for a
    // diff: snapshot it before the call runs and compare once the call reports DONE. Parameters
    // that already carry the content win, and a file that cannot be read leaves the row as is.
    const parameters = step.tool_info?.parameters;
    const snapshotPath = snapshotTarget(parameters);
    // A read tool is the one chance to see the file as it was before a later edit changes it, and
    // only as the step *arrives*: re-reading when the step finishes would race whatever changed
    // the file in between and store the result as if the step had shown it.
    if (
      snapshotPath &&
      isObservedTool(name) &&
      (step.state !== STEP_STATE_DONE || !session.observed.has(snapshotPath))
    ) {
      rememberObserved(session, snapshotPath);
    }
    const target = isSnapshotTool(name) && !hasEditContent(detail) ? snapshotPath : null;

    if (step.state === STEP_STATE_DONE) {
      turn.tools.delete(callId);
      const before = turn.snapshots.get(callId);
      turn.snapshots.delete(callId);
      publish(session, emit, { type: "tool_call", ...tool, status: "completed", error: null });
      if (target && before) void publishEditDiff(session, emit, tool, target, before);
      return;
    }
    turn.tools.set(callId, tool);
    if (!turn.schema) scheduleBackfill(session, turn, emit);
    if (target) turn.snapshots.set(callId, readSnapshot(target));
    publish(session, emit, { type: "tool_call", ...tool, status: "running", error: null });
    return;
  }

  // `ask_question` arrives as a bare `unknown` step; whether it was one is in the transcript.
  if (step.step_type === STEP_UNKNOWN && step.state === STEP_STATE_DONE && turn) {
    void relaySkippedQuestion(session, turn, step.step_index, emit);
    return;
  }

  // `user_input` is published by the provider with its clientMessageId, and `system_message`
  // carries no user-facing content, so neither becomes a timeline row.
}

/** The tool whose children this plugin follows. */
const INVOKE_SUBAGENT = "invoke_subagent";
/** How a turn settles the tool rows it left open. */
type ToolTerminal =
  | { status: "canceled" }
  | { status: "completed" }
  | { status: "failed"; error: ProviderError };
/** A child session's rows are addressed to `<parent session id>:subagent:<child conversation>`. */
const CHILD_SESSION_MARKER = ":subagent:";
/** The child's prompt is a description, not a row: enough of it to say what the child is doing. */
const DESCRIPTION_LIMIT = 200;

/** One child as a subagent step reports it, whichever of the two lines carried it. */
interface SubagentEntry {
  typeName?: string;
  role?: string;
  prompt?: string;
  conversationId?: string;
  logUri?: string;
  workspaceUris?: readonly string[];
}

/** The children a step names: the subagent line first, the tool call's parameters second. */
function readSubagentEntries(step: AgyStepUpdate): SubagentEntry[] {
  const reported = step.subagent_info?.subagents;
  if (reported && reported.length > 0) {
    return reported.map((child) => ({
      ...(child.type_name !== undefined ? { typeName: child.type_name } : {}),
      ...(child.role !== undefined ? { role: child.role } : {}),
      ...(child.initial_prompt !== undefined ? { prompt: child.initial_prompt } : {}),
      ...(child.conversation_id !== undefined ? { conversationId: child.conversation_id } : {}),
      ...(child.log_uri !== undefined ? { logUri: child.log_uri } : {}),
      ...(child.workspace_uris !== undefined ? { workspaceUris: child.workspace_uris } : {}),
    }));
  }

  // The tool line carries the same children before they exist: what the model asked for, with the
  // prompt it wrote, which is all the row can show until the subagent line names their runs.
  const parameters = step.tool_info?.parameters;
  const requested = parameters?.Subagents;
  if (!Array.isArray(requested)) return [];
  const entries: SubagentEntry[] = [];
  for (const child of requested) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
    const record = child as Record<string, unknown>;
    entries.push({
      ...(typeof record.TypeName === "string" ? { typeName: record.TypeName } : {}),
      ...(typeof record.Role === "string" ? { role: record.Role } : {}),
      ...(typeof record.Prompt === "string" ? { prompt: record.Prompt } : {}),
    });
  }
  return entries;
}

/** The rows a step justifies: one per child, or a single nameless row when it names none. */
function handleSubagentStep(
  session: Session,
  step: AgyStepUpdate,
  turn: PendingTurn,
  name: string,
  emit: Emit,
): void {
  const entries = readSubagentEntries(step);
  console.log(
    `[antigravity] subagent ${name} ${step.state} children=${entries.length} idx=${step.step_index}`,
  );

  const count = Math.max(entries.length, 1);
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index] ?? {};
    // The step index and the child's position in it, not the call: agy reports one call spawning
    // several children, and each of them is its own row and its own session.
    const id = `agy:subagent:${turn.turnId}:${step.step_index}:${index}`;
    const row =
      session.subagents.get(id) ??
      createSubagentRow(name, id, turn.turnId, step.step_index, index, null);

    // The tool line's child and the subagent line's are the same child, so every field is set by
    // whichever line has it: the DONE line adds the conversation and its transcript's location to
    // the prompt and role the ACTIVE line already gave.
    if (entry.typeName !== undefined) row.info.typeName = entry.typeName;
    if (entry.role !== undefined) row.info.role = entry.role;
    if (entry.prompt !== undefined) row.info.prompt = entry.prompt;
    if (entry.conversationId !== undefined) row.info.conversationId = entry.conversationId;
    if (entry.logUri !== undefined) row.info.logUri = entry.logUri;
    if (entry.workspaceUris !== undefined) row.info.workspaceUris = entry.workspaceUris;
    if (entry.prompt !== undefined && row.log.length === 0) row.log = entry.prompt;

    refreshSubagentRow(row);
    session.subagents.set(id, row);
    turn.tools.set(id, row);
    publishSubagent(session, emit, row);

    if (row.status === "running" && entry.conversationId !== undefined && entry.logUri !== undefined) {
      void startChildFollow(session, emit, row, entry.conversationId, entry.logUri, row.info.workspaceUris);
    }
  }
}

function createSubagentRow(
  name: string,
  id: string,
  turnId: string | null,
  stepIndex: number,
  index: number,
  host: ChildFollow | null,
): SubagentRow {
  return {
    id,
    callId: id,
    name,
    detail: { type: "sub_agent", log: "" },
    metadata: {},
    turnId,
    host,
    stepIndex,
    info: { index },
    log: "",
    status: "running",
    error: null,
    childSessionId: null,
    published: null,
  };
}

/** The row's rendered fields, rebuilt from what the stream and the child have reported so far. */
function refreshSubagentRow(row: SubagentRow): void {
  const type = row.info.role ?? row.info.typeName;
  row.detail = {
    type: "sub_agent",
    ...(row.info.typeName !== undefined ? { subAgentType: row.info.typeName } : {}),
    ...(type !== undefined ? { description: type } : {}),
    ...(row.childSessionId !== null ? { childSessionId: row.childSessionId } : {}),
    log: row.log,
    ...(row.actions !== undefined ? { actions: row.actions } : {}),
  };
  row.metadata = {
    stepIndex: row.stepIndex,
    subagent: {
      index: row.info.index,
      ...(row.info.conversationId !== undefined ? { conversationId: row.info.conversationId } : {}),
      ...(row.info.logUri !== undefined ? { logUri: row.info.logUri } : {}),
      ...(row.info.typeName !== undefined ? { typeName: row.info.typeName } : {}),
      ...(row.info.role !== undefined ? { role: row.info.role } : {}),
      ...(row.info.prompt !== undefined ? { prompt: row.info.prompt } : {}),
      ...(row.info.done === true ? { done: true } : {}),
    },
  };
}

/** The row Paseo is given for a subagent in the state it now holds. */
function subagentItem(row: SubagentRow): ProviderTimelineItem {
  const base = {
    type: "tool_call" as const,
    id: row.id,
    callId: row.callId,
    name: row.name,
    detail: row.detail,
    metadata: row.metadata,
  };
  return row.status === "failed"
    ? { ...base, status: "failed", error: row.error }
    : { ...base, status: row.status, error: null };
}

/**
 * Republishes a subagent row if, and only if, what it renders has changed. A child reports on
 * every read of its transcript, and most reads say nothing new; publishing regardless would put
 * the same row through Paseo and through the parent's stored transcript on every one of them.
 */
function publishSubagent(session: Session, emit: Emit, row: SubagentRow): void {
  const item = subagentItem(row);
  const json = JSON.stringify(item);
  if (json === row.published) return;
  row.published = json;
  const host = row.host;
  if (host === null) {
    publish(session, emit, item);
    return;
  }
  // The row of a subagent's own subagent lives in that subagent's timeline, stored with it. A
  // host that is no longer open has nowhere to show it, but what the row says is still history.
  host.store?.upsert(item);
  if (host.opened && session.childSessions.has(host.childId)) {
    emit({ type: "timeline.item", sessionId: host.childId, item });
  }
}

function childSessionId(parentSessionId: string, childConversationId: string): string {
  return `${parentSessionId}${CHILD_SESSION_MARKER}${childConversationId}`;
}

/** The child's own turn: one turn per child conversation, named after it. */
function childTurnId(childConversationId: string): string {
  return `agy-sub:${childConversationId}`;
}

/**
 * Closes a settled child's session, leaving it in the set of children this parent still has open.
 *
 * The host counts a child as live until it is closed, and on a lost connection it reports
 * `session.runtime_failed` for every live session — which is what turned finished children into
 * `failed` ones after a plugin reload. So a child closes as soon as its own turn is over, and with
 * the same error its turn ended with: the host reads a silent close as a child that completed.
 */
function closeChildSession(
  session: Session,
  emit: Emit,
  follow: ChildFollow,
  error?: ProviderError,
): void {
  // Several paths settle the same child — the child finishing, the turn ending, the transcript
  // being given up on — and only the first of them may close the session.
  if (!session.childSessions.delete(follow.childId)) return;
  follow.closePending = false;
  emit({
    type: "session.closed",
    sessionId: follow.childId,
    ...(error !== undefined ? { error } : {}),
  });
  releaseFromHost(session, emit, follow);
}

/**
 * Closes a child that said its last word, unless subagents it started are still running: their
 * rows are drawn in its session, so it stays open until the last of them is over.
 */
function requestChildClose(session: Session, emit: Emit, follow: ChildFollow): void {
  if (follow.nested.size > 0) {
    follow.closePending = true;
    return;
  }
  closeChildSession(session, emit, follow);
}

/** A child is over; the child that started it may now be closable. */
function releaseFromHost(session: Session, emit: Emit, follow: ChildFollow): void {
  releaseNested(session, emit, follow.host, follow.rowId);
}

function releaseNested(
  session: Session,
  emit: Emit,
  host: ChildFollow | null,
  rowId: string,
): void {
  if (host === null || !host.nested.delete(rowId)) return;
  if (host.closePending && host.nested.size === 0) closeChildSession(session, emit, host);
}

/**
 * The directory a child works in, which its transcript renders paths against and its session
 * reports as its cwd.
 *
 * Verified against agy 1.2.11 (fixtures/14-subagent-worktree.ndjson): `workspace_uris[0]` is the
 * child's *own* directory — the parent workspace for a `Workspace: inherit` child (fixture 12), and
 * `<appDataDir>/worktrees/<parent conversation id>/<worktree name>` for a `branch` child — as a
 * `file://` URI. Only such a URI names a directory here: anything else, or one whose path cannot be
 * decoded, leaves the child where the parent is rather than inventing a working directory.
 */
export function resolveChildCwd(parentCwd: string, workspaceUris?: readonly string[]): string {
  const first = workspaceUris?.[0];
  if (!first || first.trim().length === 0) return parentCwd;
  return transcriptFilePath(first) ?? parentCwd;
}

/**
 * Starts following the transcript of one child. Everything here is best-effort: a transcript that
 * cannot be read, parsed, or watched costs the child's own session and nothing else — the row the
 * stream justified stays on screen, and the parent's turn is never failed or delayed by it. This
 * is the only caller of `followChildTranscript`, and the only place that has to be sure of that.
 */
async function startChildFollow(
  session: Session,
  emit: Emit,
  row: SubagentRow,
  childConversationId: string,
  logUri: string,
  workspaceUris?: readonly string[],
): Promise<void> {
  try {
    await followChildTranscript(session, emit, row, childConversationId, logUri, workspaceUris);
  } catch (error) {
    // Nothing a child does may fail or delay the parent's turn, so anything that goes wrong here
    // ends with the child's transcript unfollowed and a line in the log.
    console.error(
      `[antigravity] could not follow subagent ${childConversationId}: ${describe(error)}`,
    );
    // No follow was left behind, so nothing will ever report this child over: it must not hold
    // its host open.
    if (!session.follows.has(row.id)) releaseNested(session, emit, row.host, row.id);
  }
}

async function followChildTranscript(
  session: Session,
  emit: Emit,
  row: SubagentRow,
  childConversationId: string,
  logUri: string,
  workspaceUris?: readonly string[],
): Promise<void> {
  if (session.follows.has(row.id) || session.closing) return;

  // The child's rows are stored under the child's own conversation, so a reload can replay them
  // with the child. Loading first means a resumed child keeps the rows its earlier run produced.
  let store: TranscriptStore | null = null;
  if (session.persist) {
    try {
      store = await TranscriptStore.load(childConversationId);
    } catch (error) {
      console.error(
        `[antigravity] could not read the transcript of ${childConversationId}: ${describe(error)}`,
      );
    }
  }
  // The await above is long enough for the session to have closed under us.
  if (session.closing || session.follows.has(row.id)) return;

  const follow = createChildFollow(
    session,
    emit,
    row,
    childConversationId,
    logUri,
    workspaceUris,
    store,
    false,
  );
  registerFollow(session, follow);
  follow.transcript.start();
}

function createChildFollow(
  session: Session,
  emit: Emit,
  row: SubagentRow,
  childConversationId: string,
  logUri: string,
  workspaceUris: readonly string[] | undefined,
  store: TranscriptStore | null,
  opened: boolean,
): ChildFollow {
  const host = row.host;
  const follow: ChildFollow = {
    rowId: row.id,
    childConversationId,
    childId: childSessionId(session.sessionId, childConversationId),
    turnId: row.turnId,
    cwd: resolveChildCwd(session.config.cwd, workspaceUris),
    store,
    opened,
    done: false,
    host,
    hostSessionId: host?.childId ?? session.sessionId,
    parentConversationId: host?.childConversationId ?? session.conversationId ?? "",
    depth: host === null ? 0 : host.depth + 1,
    nested: new Set(),
    closePending: false,
    transcript: null as unknown as SubagentTranscript,
  };
  follow.transcript = new SubagentTranscript(
    {
      logUri,
      childConversationId,
      parentConversationId: follow.parentConversationId,
      cwd: follow.cwd,
    },
    {
      onRender: (render, changed) => handleChildRender(session, emit, follow, render, changed),
      // A transcript that cannot be followed at all leaves the row exactly as A published it,
      // which is why this degrades to that rather than removing or failing anything.
      onDegrade: (reason) => {
        console.error(`[antigravity] not following subagent ${childConversationId}: ${reason}`);
        releaseFromHost(session, emit, follow);
      },
      onLost: (reason) => handleChildLost(session, emit, follow, reason),
      isBusy: () => follow.nested.size > 0,
    },
  );
  return follow;
}

/** Follows a child from now on, so its host does not close while it runs. */
function registerFollow(session: Session, follow: ChildFollow): void {
  session.follows.set(follow.rowId, follow);
  follow.host?.nested.add(follow.rowId);
}

/** Publishes what a child has done since the last read, and settles it when it is finished. */
function handleChildRender(
  session: Session,
  emit: Emit,
  follow: ChildFollow,
  render: ChildRender,
  changed: readonly ProviderTimelineItem[],
): void {
  if (session.closing) return;
  // The session opens on the first read that has something in it: a transcript that is missing or
  // is still empty must not put a child on screen that never says anything.
  if (!follow.opened) {
    if (render.items.length === 0) return;
    follow.opened = true;
    session.childSessions.add(follow.childId);
    const row = session.subagents.get(follow.rowId);
    const title = row?.info.role ?? row?.info.typeName ?? "Subagent";
    emit({
      type: "session.opened",
      sessionId: follow.childId,
      // A subagent started by another subagent hangs off that one, not off the conversation.
      parentSessionId: follow.hostSessionId,
      toolCallId: follow.rowId,
      capabilities: [],
      restoration: "parent",
      title,
      description: (row?.info.prompt ?? "").slice(0, DESCRIPTION_LIMIT),
      // The child's own directory, which is its worktree when the model branched one.
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

  const spawns = new Map(render.spawns.map((spawn) => [spawn.id, spawn]));
  for (const item of changed) {
    // The call that started a subagent is drawn as the row this plugin keeps for it, in the place
    // the call held among the child's rows.
    const spawn = spawns.get(item.id);
    if (spawn !== undefined) {
      handleSpawn(session, emit, follow, spawn);
      continue;
    }
    if (follow.store) follow.store.upsert(item);
    emit({ type: "timeline.item", sessionId: follow.childId, item });
  }

  follow.done = render.done;
  const row = session.subagents.get(follow.rowId);
  if (row) {
    row.childSessionId = follow.childId;
    if (render.report.length > 0) row.log = render.report;
    if (render.actions.length > 0) row.actions = [...render.actions];
    if (render.done) row.info.done = true;
    // The child finished, and the row does not need the turn to say so; a row something else has
    // already settled keeps that status, since a later report cannot unsay what happened.
    if (render.done && row.status === "running") row.status = "completed";
    refreshSubagentRow(row);
    publishSubagent(session, emit, row);
  }

  if (render.done) {
    emit({
      type: "session.turn",
      sessionId: follow.childId,
      turnId: childTurnId(follow.childConversationId),
      state: "completed",
    });
    requestChildClose(session, emit, follow);
    follow.transcript.stop();
    // The child's rows are complete here, so they no longer have to wait out the write debounce:
    // a session closed right after this still replays everything the child said.
    void follow.store?.flush();
  }
}

/**
 * A subagent that a child started: a row in that child's session, and — once the call's result
 * names the conversation it runs in — a child session of its own, followed like any other.
 */
function handleSpawn(session: Session, emit: Emit, host: ChildFollow, spawn: ChildSpawn): void {
  const row =
    session.subagents.get(spawn.id) ??
    createSubagentRow(INVOKE_SUBAGENT, spawn.id, host.turnId, spawn.stepIndex, spawn.index, host);
  if (spawn.typeName !== undefined) row.info.typeName = spawn.typeName;
  if (spawn.role !== undefined) row.info.role = spawn.role;
  if (spawn.prompt !== undefined) row.info.prompt = spawn.prompt;
  if (spawn.conversationId !== undefined) row.info.conversationId = spawn.conversationId;
  if (spawn.logUri !== undefined) row.info.logUri = spawn.logUri;
  if (spawn.workspaceUris !== undefined) row.info.workspaceUris = spawn.workspaceUris;
  if (spawn.prompt !== undefined && row.log.length === 0) row.log = spawn.prompt;

  refreshSubagentRow(row);
  session.subagents.set(spawn.id, row);
  publishSubagent(session, emit, row);

  if (row.status === "running" && spawn.conversationId !== undefined && spawn.logUri !== undefined) {
    // Counted as running from now, not from when its follow exists: that takes a read of the
    // store, and the host may say its last word before then.
    host.nested.add(row.id);
    void startChildFollow(session, emit, row, spawn.conversationId, spawn.logUri, row.info.workspaceUris);
  }
}

/** The child stopped writing before finishing: its own turn is canceled, never completed. */
function handleChildLost(session: Session, emit: Emit, follow: ChildFollow, reason: string): void {
  console.error(`[antigravity] stopped following subagent ${follow.childConversationId}`);
  if (session.closing) return;
  if (follow.opened && !follow.done) {
    const error: ProviderError = { message: reason };
    emit({
      type: "session.turn",
      sessionId: follow.childId,
      turnId: childTurnId(follow.childConversationId),
      state: "canceled",
      error,
    });
    // What the child did say is its history whatever ended it, so it is written out now rather
    // than left to a debounce that may never fire.
    void follow.store?.flush();
    closeChildSession(session, emit, follow, error);
  }
  releaseFromHost(session, emit, follow);
}

/**
 * The parent's turn is over, so the children it spawned are no longer going to be reported on it.
 * Each transcript gets one last read — the child may well have finished while the parent was
 * writing its answer — and then is left alone; a child that had not finished is canceled or failed
 * along with the turn that spawned it.
 */
async function settleChildFollows(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  outcome: { state: "canceled"; error: ProviderError } | { state: "failed"; error: ProviderError },
): Promise<void> {
  // Deepest first: a child's session stays open for as long as the subagents it started, so those
  // are settled before it is. A read can reveal subagents nobody had seen yet, which is why the
  // next one is chosen afresh each time rather than taken from a list made up front.
  for (;;) {
    let follow: ChildFollow | undefined;
    for (const candidate of session.follows.values()) {
      if (candidate.turnId !== turn.turnId) continue;
      if (follow === undefined || candidate.depth > follow.depth) follow = candidate;
    }
    if (follow === undefined) return;
    session.follows.delete(follow.rowId);
    try {
      await follow.transcript.readFinal();
    } catch (error) {
      console.error(
        `[antigravity] could not read the last of subagent ${follow.childConversationId}: ${describe(error)}`,
      );
    }
    follow.transcript.stop();
    // The child said everything it is going to say, so its rows are written out now rather than
    // left to a debounce this session may not live long enough to see.
    void follow.store?.flush();
    if (session.closing) continue;
    // A top-level row is settled with the tools of its turn; a nested one is in no turn's tools.
    const row = session.subagents.get(follow.rowId);
    if (follow.host !== null && row !== undefined && row.status === "running") {
      if (outcome.state === "failed") {
        row.status = "failed";
        row.error = toErrorJson(outcome.error);
      } else {
        row.status = "canceled";
      }
      publishSubagent(session, emit, row);
    }
    if (!follow.done && follow.opened) {
      emit({
        type: "session.turn",
        sessionId: follow.childId,
        turnId: childTurnId(follow.childConversationId),
        state: outcome.state,
        error: outcome.error,
      });
      closeChildSession(session, emit, follow, outcome.error);
    }
    releaseFromHost(session, emit, follow);
  }
}

function handleResult(session: Session, result: AgyResult, emit: Emit): void {
  const turn = session.pendingTurns.shift() ?? null;
  if (turn) stopBackfill(turn);
  console.log(
    `[antigravity] result status=${result.status} turns=${result.num_turns ?? "-"} text=${
      (result.response ?? "").length
    } chars${result.error ? ` error=${result.error}` : ""}`,
  );

  // `result.usage.input_tokens` totals every step of the turn, so on its own it overstates what
  // the model is holding; the last step's own count is the context occupancy.
  const contextWindowUsedTokens = turn?.contextInputTokens;
  if (result.usage || contextWindowUsedTokens !== undefined) {
    emit({
      type: "session.usage",
      sessionId: session.sessionId,
      turnId: turn?.turnId,
      usage: {
        ...(result.usage ? toProviderUsage(result.usage) : {}),
        ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
      },
    });
  }

  if (turn === null) {
    console.error(`[antigravity] ignoring a result with no active turn (${result.status})`);
    return;
  }

  if (result.status === "SUCCESS") {
    const response = result.response ?? "";
    if (turn.schema) {
      if (result.structured_output !== undefined) {
        // The decoded answer is the turn's only assistant row. agy's `response` repeats the same
        // JSON with `toolAction`/`toolSummary` added, so it must never be published, and the
        // streamed prose was never published either (see `handleStepUpdate`).
        const json = JSON.stringify(result.structured_output);
        publish(session, emit, {
          type: "assistant_message",
          id: `agy:schema:${turn.turnId}`,
          text: json ?? "",
        });
      } else {
        // A schema process that decoded nothing: what it said is published now, or the result's
        // own text when it streamed none.
        publishBufferedAnswer(session, emit, turn, response);
      }
    } else if (!turn.hadAssistantText && response.trim().length > 0) {
      // Safety net: agy answered without streaming any assistant text.
      publish(session, emit, {
        type: "assistant_message",
        id: `agy:result:${turn.turnId}`,
        text: response,
      });
    }
    // A subagent row is left running by its step, because the child it names outlives the call.
    // The turn ending is what closes the books: whatever the stream never settled is done as far
    // as this turn is concerned, and a child still followed keeps following until it finishes.
    finalizeToolCalls(session, emit, turn, { status: "completed" });
    emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "completed" });
    if (!turn.schema) offerPlan(session, emit, turn, lastAssistantText(turn) || response);
    return;
  }

  if (isInterrupted(result)) {
    publishBufferedAnswer(session, emit, turn);
    finalizeToolCalls(session, emit, turn, { status: "canceled" });
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: "canceled",
      error: { message: "Interrupted" },
    });
    void settleChildFollows(session, emit, turn, {
      state: "canceled",
      error: { message: "Interrupted" },
    });
    return;
  }

  const { error, retryable } = turnFailure(session, {
    message: result.error ?? `Antigravity reported ${result.status}`,
    code: result.status,
  });
  publishBufferedAnswer(session, emit, turn);
  finalizeToolCalls(session, emit, turn, { status: "failed", error });
  emit({
    type: "session.turn",
    sessionId: session.sessionId,
    turnId: turn.turnId,
    state: "failed",
    error,
  });
  void settleChildFollows(session, emit, turn, { state: "failed", error });
  if (retryable) emitUnavailableNotice(session, emit);
}

function handleAgyExit(
  session: Session,
  info: { code: number | null; signal: NodeJS.Signals | null },
  emit: Emit,
): void {
  session.process = null;
  if (session.closing) return;

  const pending = session.pendingTurns;
  session.pendingTurns = [];
  if (pending.length === 0) return;

  // agy writes its diagnostics to stderr, which is where an invalid model or a missing sign-in
  // shows up, so surface the tail rather than a bare exit code.
  const tail = session.stderrTail.slice(-3).join(" ");
  const detail =
    tail.length > 0
      ? tail
      : `Antigravity exited (code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""})`;
  // A canceled turn is not an API failure, so the structured error line of the process that
  // happened to be signalled must not be reported as its cause.
  const failure: TurnFailure = session.interrupting
    ? { error: { message: detail, code: "interrupted" }, retryable: false }
    : turnFailure(session, { message: detail, code: "agy_exit" });

  for (const turn of pending) {
    stopBackfill(turn);
    publishBufferedAnswer(session, emit, turn);
    const canceled = session.interrupting;
    finalizeToolCalls(
      session,
      emit,
      turn,
      canceled ? { status: "canceled" } : { status: "failed", error: failure.error },
    );
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: canceled ? "canceled" : "failed",
      error: failure.error,
    });
    // The process that was serving the turn is gone, so the children it spawned can no longer be
    // followed. Their transcripts get one last read first: a child that finished while the process
    // died is still finished.
    void settleChildFollows(
      session,
      emit,
      turn,
      canceled ? { state: "canceled", error: failure.error } : { state: "failed", error: failure.error },
    );
  }
  if (failure.retryable) emitUnavailableNotice(session, emit);
}

/**
 * The error a failed turn reports. A structured `AGY_ERROR` line is canonical when the process
 * printed one; otherwise a transient outage is named `unavailable` so a retry is obvious, and any
 * other failure keeps the status agy reported or the exit-path code.
 */
function turnFailure(session: Session, fallback: { message: string; code: string }): TurnFailure {
  const report = session.agyError;
  if (report) {
    const error: ProviderError = {
      message: report.short_error ?? fallback.message,
      code: report.status ?? fallback.code,
      diagnostic: report.raw,
    };
    const retryable =
      report.retryable === true || UNAVAILABLE_PATTERN.test(`${error.code ?? ""} ${error.message}`);
    return { error, retryable };
  }
  if (UNAVAILABLE_PATTERN.test(fallback.message)) {
    return { error: { message: fallback.message, code: "unavailable" }, retryable: true };
  }
  return { error: { message: fallback.message, code: fallback.code }, retryable: false };
}

function emitUnavailableNotice(session: Session, emit: Emit): void {
  emitNotice(
    session,
    emit,
    "agy-unavailable",
    "warning",
    "Antigravity is temporarily unavailable",
    "The Antigravity service reported that it is temporarily unavailable. Retry the prompt in a moment; this usually clears on its own.",
  );
}

/**
 * A tool row published as `running` would otherwise stay running forever once its turn ends, so
 * every call left open is republished with a terminal status under the same id.
 *
 * A subagent row is republished from `session.subagents`, which holds the newest detail and
 * metadata — the child may have reported while the turn was still running — and keeps a status
 * something else has already settled: a child that finished did finish, whatever the turn then did.
 */
function finalizeToolCalls(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  terminal: ToolTerminal,
): void {
  if (turn.tools.size === 0) return;
  for (const tool of turn.tools.values()) {
    const subagent = session.subagents.get(tool.id);
    if (subagent) {
      if (subagent.status === "running") {
        if (terminal.status === "failed") {
          subagent.status = "failed";
          subagent.error = toErrorJson(terminal.error);
        } else {
          subagent.status = terminal.status;
        }
      }
      publishSubagent(session, emit, subagent);
      continue;
    }
    const base = { type: "tool_call" as const, ...tool };
    if (terminal.status === "failed") {
      publish(session, emit, { ...base, status: "failed", error: toErrorJson(terminal.error) });
    } else if (terminal.status === "canceled") {
      publish(session, emit, { ...base, status: "canceled", error: null });
    } else {
      publish(session, emit, { ...base, status: "completed", error: null });
    }
  }
  turn.tools.clear();
}

/**
 * Keeps the newest content the plugin was shown for a path, bounded so a long session cannot
 * accumulate whole files. A caller that already holds the content passes it rather than paying
 * for a second read.
 */
function rememberObserved(session: Session, path: string, snapshot?: FileSnapshot): void {
  session.observed.delete(path);
  session.observed.set(path, snapshot ? Promise.resolve(snapshot) : readSnapshot(path));
  if (session.observed.size > OBSERVED_LIMIT) {
    const oldest = session.observed.keys().next().value;
    if (oldest !== undefined) session.observed.delete(oldest);
  }
}

/**
 * Republishes a completed tool row with a diff once both snapshots of its target are in hand.
 * Nothing waits on it: the row the stream justified is already on screen, and Paseo replaces a
 * row by id, so a slow read can neither delay the turn nor reorder the rows after it.
 */
async function publishEditDiff(
  session: Session,
  emit: Emit,
  tool: OpenToolCall,
  path: string,
  before: Promise<FileSnapshot | null>,
): Promise<void> {
  try {
    const [active, current] = await Promise.all([before, readSnapshot(path)]);
    if (current === null || !current.exists) return;
    // The step's own snapshot is the "before" whenever the file still held its previous content
    // when the step arrived. When it already matches, the edit had applied before ACTIVE reached
    // the plugin, and the last content the plugin was shown is what changed.
    const observed = (await session.observed.get(path)) ?? null;
    const previous = active !== null && active.text !== current.text ? active : (observed ?? active);
    if (previous === null) return;
    if (previous.exists && previous.text === current.text) return;
    if (session.closing) return;

    // write_to_file creating a file has no earlier state to diff against, so the row shows what
    // the file now holds. Anything else is described as the edit it was.
    let detail: ProviderToolCallDetail;
    if (!previous.exists && tool.name === "write_to_file") {
      detail = { type: "write", filePath: path, content: current.text };
    } else {
      const unifiedDiff = snapshotDiff(path, previous.text, current.text, session.config.cwd);
      if (unifiedDiff === null) return;
      detail = { type: "edit", filePath: path, unifiedDiff };
    }

    publish(session, emit, { type: "tool_call", ...tool, detail, status: "completed", error: null });
    rememberObserved(session, path, current);
  } catch (error) {
    console.error(
      `[antigravity] could not diff ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function publish(session: Session, emit: Emit, item: ProviderTimelineItem): void {
  if (session.transcript) session.transcript.upsert(item);
  else if (session.persist) session.unpersisted.push(item);
  emit({ type: "timeline.item", sessionId: session.sessionId, item });
}

/**
 * Publishes the text a schema turn buffered while streaming none. A plain turn's text is already
 * on screen, and republishing it would append a second copy under Paseo's delta mapping. `fallback`
 * is the result's own text, used when the process produced no text at all.
 */
function publishBufferedAnswer(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  fallback = "",
): void {
  if (!turn.schema) return;
  const buffered = [...turn.assistant.values()].join("");
  const text = buffered.trim().length > 0 ? buffered : fallback;
  if (text.trim().length === 0) return;
  publish(session, emit, {
    type: "assistant_message",
    id: `agy:result:${turn.turnId}`,
    text,
  });
}

/** A prompt that never became a turn: nothing was written to agy and no turn id exists yet. */
function failPrompt(
  session: Session,
  emit: Emit,
  clientMessageId: string,
  error: ProviderError,
): void {
  emit({
    type: "session.prompt_result",
    sessionId: session.sessionId,
    clientMessageId,
    result: { type: "failed", error },
  });
}

function emitNotice(
  session: Session,
  emit: Emit,
  id: string,
  severity: "info" | "warning" | "error",
  title: string,
  description: string,
): void {
  emit({
    type: "session.notice",
    sessionId: session.sessionId,
    notice: { id, severity, title, description },
  });
}

function configState(session: Session): ProviderConfigState {
  // The tier belongs to the selected model, so the composer's axis is that model's own tiers and
  // the committed option is the one the next launch will actually pass. Both the list and the tiers
  // are the account's: another account's `agy models` output has no say in this session.
  const thinking = resolveThinking(
    session.selection.model,
    session.selection.thinkingOption,
    session.accountId,
  );
  return {
    model: session.selection.model,
    mode: session.selection.mode ?? DEFAULT_MODE_ID,
    thinkingOption: thinking.option,
    models: currentModels(session.accountId),
    modes: MODES,
    thinkingOptions: thinking.options,
    settings: buildSettings(session),
  };
}

function buildSettings(session: Session): readonly ProviderSetting[] {
  const policy = approvalPolicy(session);
  // Antigravity decides through its own setting unless the user overrides it here, so the row
  // names that value rather than guessing at what a headless run will do. `agy` reads it from the
  // account's home, so this does too: the value a launch would actually use.
  const permission = readToolPermission(accountGeminiRoot(session.accountId)) ?? "unknown";
  return [
    ...(session.availableAgents.length > 0 || session.agent !== undefined
      ? [
          {
            type: "select" as const,
            id: "agent",
            label: "Agent profile",
            description: "Run under a project or global custom agent profile (--agent <name>).",
            value: chosenAgent(session),
            options: agentOptions(session),
          },
        ]
      : []),
    {
      type: "select",
      id: "approvalPolicy",
      label: "Tool approval",
      description:
        policy === "skip"
          ? `Every tool runs without asking (--dangerously-skip-permissions), overriding Antigravity's toolPermission (${permission}).`
          : `Antigravity decides, using its own toolPermission setting (${permission}).`,
      value: policy,
      options: [
        { label: "Use Antigravity setting", value: "agy" },
        { label: "Skip all permissions", value: "skip" },
      ],
    },
    {
      type: "select",
      id: "sandbox",
      label: "Sandbox",
      description: "On passes --sandbox, which restricts what terminal commands can reach.",
      value: onOff(session.settings.sandbox),
      options: ON_OFF_OPTIONS,
    },
    {
      type: "select",
      id: "shareMcp",
      label: "Share Paseo tools with Antigravity",
      description:
        Object.keys(session.config.mcpServers).length === 0
          ? "Paseo has no MCP servers configured for this session, so there is nothing to share."
          : `On writes Paseo's MCP servers into ${mcpConfigPath(session.config.cwd)} as paseo-* entries, where Antigravity can reach them. That file holds their credentials, so it must stay out of version control.`,
      value: onOff(session.settings.shareMcp),
      options: ON_OFF_OPTIONS,
    },
  ];
}

/**
 * The agent the select shows: the setting while one is chosen, else what a launch would pass
 * (`selectedAgent`'s fallback), so the row never disagrees with the flags.
 */
function chosenAgent(session: Session): string {
  const setting = session.settings.agent;
  if (typeof setting === "string" && setting.trim().length > 0) return setting.trim();
  return session.agent ?? "default";
}

/**
 * The agent select's options. A `providerOptions.agent` — or a setting saved elsewhere — may name
 * an agent this workspace scan does not offer (a global one, or one only the CLI knows). That name
 * still reaches `--agent`, so it is offered here too: a select whose value is not among its own
 * options shows the user something they cannot select back.
 */
function agentOptions(session: Session): ReadonlyArray<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [
    { label: "Default (general)", value: "default" },
    ...session.availableAgents.map((agent) => ({
      label: agent.description ? `${agent.name} (${agent.description})` : agent.name,
      value: agent.name,
    })),
  ];
  const chosen = chosenAgent(session);
  if (!options.some((option) => option.value === chosen)) {
    options.push({ label: chosen, value: chosen });
  }
  return options;
}

/**
 * Paseo draws plugin toggles as icon-only buttons with no on/off state, so a boolean setting is
 * offered as a two-option select instead: Paseo then shows the current value as a pill. A value
 * saved while the setting was a toggle (`true`/`false`) still reads correctly.
 */
const ON_OFF_OPTIONS = [
  { label: "Off", value: "off" },
  { label: "On", value: "on" },
] as const;

function onOff(value: JsonValue | undefined): "on" | "off" {
  return isSettingOn(value) ? "on" : "off";
}

/** `true` and `"on"` are on; everything else — `false`, `"off"`, a missing setting — is off. */
function isSettingOn(value: JsonValue | undefined): boolean {
  return value === true || value === "on";
}

/**
 * `agy` defers approval to Antigravity's own `toolPermission` setting and passes no flag; `skip`
 * passes --dangerously-skip-permissions. A session persisted before this select existed carries
 * the removed `autoApprove` toggle, which was on by default and meant the same as `skip`.
 */
function approvalPolicy(session: Session): "agy" | "skip" {
  const value = session.settings.approvalPolicy;
  if (value === "agy" || value === "skip") return value;
  return session.settings.autoApprove === true ? "skip" : "agy";
}

/**
 * The agent the next launch passes to `--agent`, if any. The composer's own setting is what the
 * user is looking at, so an explicit `"default"` means the CLI's default agent and beats a
 * `providerOptions.agent` — which only applies while no setting has been chosen at all.
 */
function selectedAgent(session: Session): string | undefined {
  const fromSetting = session.settings.agent;
  if (fromSetting === "default") return undefined;
  if (typeof fromSetting === "string" && fromSetting.trim().length > 0) return fromSetting.trim();
  return session.agent;
}

function requireSession(state: ConnectionState, sessionId: string): Session {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

function itemId(turn: PendingTurn, stepIndex: number, kind: string): string {
  return `agy:${kind}:${turn.turnId}:${stepIndex}`;
}

function toErrorJson(error: ProviderError): JsonValue {
  return {
    message: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.diagnostic !== undefined ? { diagnostic: error.diagnostic } : {}),
  };
}

/**
 * The blob Paseo stores for this conversation. `accountId` decides which account's home a resume
 * launches in, so it travels with `conversationId`; the extra key needs no version bump, since a
 * reader of version 1 already ignores what it does not know.
 */
function persistenceFor(conversationId: string | null, accountId: string): ProviderPersistence {
  return { version: 1, data: { conversationId, accountId } };
}

/** A version-1 string field of the persistence blob, or `null` when it is absent or unusable. */
function persistenceField(
  persistence: ProviderPersistence | undefined,
  key: "conversationId" | "accountId",
): string | null {
  if (!persistence || persistence.version !== 1) return null;
  const data = persistence.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = (data as Record<string, JsonValue>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Which account a session runs under.
 *
 * A resume names the account that created the conversation. A persisted conversation with no
 * `accountId` predates accounts and can only have run under Default, which is also what a
 * conversation written by plain `agy` outside Paseo is. A brand-new conversation takes the
 * host-wide active account. A named account that is gone fails the open rather than silently
 * handing the conversation to another account.
 */
function resolveAccountId(
  persistence: ProviderPersistence | undefined,
  conversationId: string | null,
): string {
  const stored = persistenceField(persistence, "accountId");
  if (stored !== null && stored !== DEFAULT_ACCOUNT_ID) {
    if (!readAccounts().accounts.some((account) => account.id === stored)) {
      throw new Error(
        `Antigravity account "${stored}" no longer exists, so this conversation cannot be resumed`,
      );
    }
    return stored;
  }
  if (stored !== null) return DEFAULT_ACCOUNT_ID;
  if (conversationId !== null) return DEFAULT_ACCOUNT_ID;
  return readAccounts().active;
}

function readProviderOptions(config: ProviderSessionConfig): {
  agyPath?: string;
  extraArgs?: readonly string[];
  addDirs?: readonly string[];
  agent?: string;
  effort?: string;
} {
  const options = config.providerOptions ?? {};
  const rawPath = options.agyPath;
  const rawArgs = options.extraArgs;
  const rawDirs = options.addDirs;
  const rawAgent = options.agent;
  const rawEffort = options.effort;
  return {
    agyPath: typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath : undefined,
    extraArgs: Array.isArray(rawArgs)
      ? rawArgs.filter((arg): arg is string => typeof arg === "string")
      : undefined,
    addDirs: Array.isArray(rawDirs)
      ? rawDirs.filter((dir): dir is string => typeof dir === "string")
      : undefined,
    agent: typeof rawAgent === "string" && rawAgent.trim().length > 0 ? rawAgent.trim() : undefined,
    effort: typeof rawEffort === "string" && rawEffort.trim().length > 0 ? rawEffort.trim() : undefined,
  };
}

/**
 * `agy` resolves every `--add-dir` against the filesystem at startup, so a path that is not an
 * absolute existing directory is dropped here, and the session says which ones were left out
 * instead of failing the launch or letting the model see a directory the user did not intend.
 */
async function checkAddDirs(
  paths: readonly string[] | undefined,
): Promise<{ kept: string[]; dropped: string[] }> {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const path of paths ?? []) {
    if (!isAbsolute(path)) {
      dropped.push(path);
      continue;
    }
    try {
      if ((await stat(path)).isDirectory()) kept.push(path);
      else dropped.push(path);
    } catch {
      dropped.push(path);
    }
  }
  return { kept, dropped };
}

/** Antigravity has no system-prompt flag, so it is prepended to the first turn of a conversation. */
function buildOutgoingText(session: Session, text: string): string {
  if (session.systemPromptSent) return text;
  const systemPrompt = session.config.systemPrompt?.trim();
  if (!systemPrompt) return text;
  return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${text}`;
}

/**
 * Renders the prompt's parts for agy's text-only stream input. An image part is written to the
 * session's attachments folder and referenced by absolute path: agy rejects image content blocks
 * outright, but reads an image file with `view_file` (probed 2026-09-23).
 */
async function renderPromptContent(
  session: Session,
  content: readonly ProviderContent[],
): Promise<string> {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "image") {
      if (session.attachmentsDir === null) {
        throw new Error("the attachments folder could not be created");
      }
      session.attachmentCount += 1;
      const path = await writeAttachment(
        session.sessionId,
        session.attachmentCount,
        part.data,
        part.mimeType,
      );
      parts.push(`[image attached: ${path} — view it with view_file]`);
      continue;
    }
    parts.push(renderPart(part));
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function renderPart(part: Exclude<ProviderContent, { type: "image" }>): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "uploaded_file":
      return `[uploaded file: ${part.path}]`;
    case "review":
      return renderReview(part);
    case "forge_change_request":
    case "forge_issue":
    case "github_pr":
    case "github_issue": {
      const header = `[${part.title}](${part.url})`;
      return part.body ? `${header}\n\n${part.body}` : header;
    }
    default:
      return "";
  }
}

function renderReview(part: Extract<ProviderContent, { type: "review" }>): string {
  const lines = [`[code review · ${part.mode}] ${part.cwd}`];
  for (const comment of part.comments) {
    lines.push(`\n${comment.filePath}:${comment.lineNumber} (${comment.side})\n${comment.body}`);
  }
  return lines.join("\n");
}

function toProviderUsage(usage: AgyUsage): ProviderUsage {
  const outputTokens = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_tokens,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
  };
}

function toJson(value: Record<string, unknown>): JsonValue {
  return structuredClone(value) as JsonValue;
}

/**
 * Daemon-side trace of protocol traffic. Prompt and system-prompt contents are reduced to lengths
 * because the retained plugin log tail is readable by anyone connected to this daemon.
 */
function describeInput(input: ProviderInput): string {
  switch (input.type) {
    case "catalog":
      return `catalog cwd=${input.cwd ?? "-"}`;
    case "sessions":
      return `sessions query=${input.query ?? "-"}`;
    case "session.open":
      return [
        "session.open",
        `session=${input.sessionId}`,
        `cwd=${input.config.cwd}`,
        `model=${input.config.model ?? "-"}`,
        `thinkingOption=${input.config.thinkingOption ?? "-"}`,
        `mode=${input.config.mode ?? "-"}`,
        `mcpServers=${Object.keys(input.config.mcpServers).length}`,
        `toolPolicy=${input.config.toolPolicy ? input.config.toolPolicy.preapproved.length : 0}`,
        `history=${input.history}`,
        `resume=${input.persistence ? "yes" : "no"}`,
        `systemPrompt=${input.config.systemPrompt?.length ?? 0}chars`,
        `settings=${JSON.stringify(input.config.settings)}`,
      ].join(" ");
    case "session.prompt": {
      const content = input.prompt.input.type === "message" ? input.prompt.input.content : [];
      const textChars = content.reduce(
        (total, part) => total + (part.type === "text" ? part.text.length : 0),
        0,
      );
      return [
        "session.prompt",
        `session=${input.sessionId}`,
        `delivery=${input.prompt.delivery}`,
        `kind=${input.prompt.input.type}`,
        ...(input.prompt.input.type === "command" ? [`name=${input.prompt.input.name}`] : []),
        `parts=${content.length}`,
        `images=${content.filter((part) => part.type === "image").length}`,
        `text=${textChars}chars`,
        `schema=${input.prompt.outputSchema === undefined ? "no" : "yes"}`,
      ].join(" ");
    }
    case "session.configure":
      return `session.configure session=${input.sessionId} changes=${JSON.stringify(input.changes)}`;
    case "session.interrupt":
      return `session.interrupt session=${input.sessionId}`;
    case "session.close":
      return `session.close session=${input.sessionId}`;
    default:
      return input.type;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
