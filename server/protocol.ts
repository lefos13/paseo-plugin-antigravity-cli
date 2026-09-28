import { z } from "zod";

/**
 * Decoders for the NDJSON event stream produced by
 * `agy --input-format stream-json --output-format stream-json`.
 *
 * Every line is one JSON object with an `event` discriminator. Observed kinds:
 *   init         -> { conversation_id, init: { cwd, tools, permission_mode } }
 *   step_update  -> { step_update: { step_index, state, step_type, ... } }
 *   result       -> { result: { status, response, error?, num_turns, usage } } (one per turn)
 *
 * Everything is marked optional and unknown kinds are dropped rather than thrown, because
 * agy ships updates frequently and a schema drift must not take the provider down.
 */

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  thinking_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

const initSchema = z.object({
  // An empty id shows up on an eligibility failure and would name a transcript file ".jsonl".
  conversation_id: z.string().min(1),
  init: z
    .object({
      cwd: z.string().optional(),
      tools: z.array(z.string()).optional(),
      permission_mode: z.string().optional(),
    })
    .optional(),
});

const toolInfoSchema = z.object({
  name: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
});

/** One child an `invoke_subagent` step spawned, as the subagent line reports it. */
const subagentSchema = z.looseObject({
  type_name: z.string().optional(),
  role: z.string().optional(),
  initial_prompt: z.string().optional(),
  conversation_id: z.string().optional(),
  /** `file:` URL of the child's own transcript, which is how a child can be followed. */
  log_uri: z.string().optional(),
  workspace_uris: z.array(z.string()).optional(),
});

/**
 * A subagent step's payload. A shape agy cannot decode becomes `undefined` rather than failing the
 * step: dropping it would also lose the row the `invoke_subagent` tool line had already published,
 * while the children a malformed payload names are information this plugin can do without.
 */
const subagentInfoSchema = z
  .looseObject({ subagents: z.array(subagentSchema).optional() })
  .optional()
  .catch(undefined);

const stepUpdateSchema = z.object({
  conversation_id: z.string().optional(),
  step_index: z.number(),
  state: z.string(),
  step_type: z.string(),
  /** Incremental text chunk, not a snapshot. Absent on non-text steps. */
  text_delta: z.string().optional(),
  tool_name: z.string().optional(),
  tool_info: toolInfoSchema.optional(),
  subagent_info: subagentInfoSchema.optional(),
  duration_seconds: z.number().optional(),
  usage: usageSchema.optional(),
});

const resultSchema = z.object({
  conversation_id: z.string().optional(),
  status: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
  duration_seconds: z.number().optional(),
  num_turns: z.number().optional(),
  usage: usageSchema.optional(),
  /**
   * Present only when the process was launched with `--json-schema`: the model's answer decoded
   * against that schema. `response` then repeats the same JSON with extra `toolAction` /
   * `toolSummary` keys, so it is never the answer Paseo should show.
   */
  structured_output: z.unknown().optional(),
  json_schema: z.unknown().optional(),
});

export type AgyUsage = z.infer<typeof usageSchema>;
export type AgyStepUpdate = z.infer<typeof stepUpdateSchema>;
export type AgyToolInfo = z.infer<typeof toolInfoSchema>;
export type AgyResult = z.infer<typeof resultSchema>;

export type AgyEvent =
  | { kind: "init"; conversationId: string; cwd?: string; tools: readonly string[] }
  | { kind: "step_update"; step: AgyStepUpdate }
  | { kind: "result"; result: AgyResult }
  | { kind: "unknown"; event: string };

/** Values seen for `step_update.step_type`. Treated as data, never as a closed enum. */
export const STEP_USER_INPUT = "user_input";
export const STEP_AGENT_RESPONSE = "agent_response";
export const STEP_TOOL = "tool";
export const STEP_SYSTEM_MESSAGE = "system_message";
/**
 * The step agy reports once the `invoke_subagent` call it shares a `step_index` with has been
 * dispatched. It is the same step as the tool line, carrying `subagent_info` in place of
 * `tool_info`, and it arrives while the children are still running.
 */
export const STEP_SUBAGENT = "subagent";
/**
 * What agy reports for a step it has no stream type for. On 1.2.12 that includes `ask_question`,
 * which arrives with no tool name or parameters at all (fixtures/17-ask-question.ndjson).
 */
export const STEP_UNKNOWN = "unknown";

export const STEP_STATE_ACTIVE = "ACTIVE";
export const STEP_STATE_DONE = "DONE";

/** agy reports an interrupted turn as a failed result carrying this exact error string. */
export const INTERRUPTED_ERROR = "interrupted";

/**
 * The structured line agy 1.2.6+ documents as `AGY_ERROR: {...}` on stderr for a turn that ends on
 * an agent or model API failure (its changelog ties that line to headless `-p`/`--prompt` mode and
 * exit code 3). No capture in this repo produced one: a stream-json run with an invalid model, a
 * failed sign-in, a dead proxy, a 503 and an oversized prompt all reported the failure through a
 * plain `error:` line plus a failed result (fixtures/05-error.*, fixtures/05-unavailable.*).
 * The decoder is therefore best-effort: every field is optional and `raw` keeps the JSON exactly
 * as printed, so an unknown field still reaches `ProviderError.diagnostic` instead of being lost.
 */
export interface AgyErrorReport {
  /** Canonical status, e.g. `UNAVAILABLE`. */
  status?: string;
  /** One-line human summary. */
  short_error?: string;
  retryable?: boolean;
  raw: string;
}

const AGY_ERROR_PREFIX = "AGY_ERROR:";

/** Parse one stderr line into an AGY_ERROR report, or null when the line is not one. */
export function parseAgyErrorLine(line: string): AgyErrorReport | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(AGY_ERROR_PREFIX)) return null;

  const raw = trimmed.slice(AGY_ERROR_PREFIX.length).trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;

  const record = decoded as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  return {
    status: text("status"),
    short_error: text("short_error"),
    ...(record.retryable === true ? { retryable: true } : {}),
    raw,
  };
}

/**
 * Parse one line of agy stdout. Returns null for blank lines, decorated output, and anything
 * that is not a well-formed event, so callers can simply skip the line.
 */
export function parseAgyLine(raw: string): AgyEvent | null {
  const line = raw.trim();
  if (line.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;

  const envelope = decoded as Record<string, unknown>;
  const name = envelope.event;
  if (typeof name !== "string") return null;

  if (name === "init") {
    const parsed = initSchema.safeParse(envelope);
    if (!parsed.success) return { kind: "unknown", event: name };
    return {
      kind: "init",
      conversationId: parsed.data.conversation_id,
      cwd: parsed.data.init?.cwd,
      tools: parsed.data.init?.tools ?? [],
    };
  }

  if (name === "step_update") {
    const parsed = stepUpdateSchema.safeParse(envelope.step_update);
    if (!parsed.success) return { kind: "unknown", event: name };
    return { kind: "step_update", step: parsed.data };
  }

  if (name === "result") {
    const parsed = resultSchema.safeParse(envelope.result);
    if (!parsed.success) return { kind: "unknown", event: name };
    return { kind: "result", result: parsed.data };
  }

  return { kind: "unknown", event: name };
}

/** One user turn, as written to agy stdin. */
export function encodeUserTurn(text: string): string {
  return (
    JSON.stringify({
      event: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

export function isInterrupted(result: AgyResult): boolean {
  return result.status !== "SUCCESS" && result.error === INTERRUPTED_ERROR;
}
