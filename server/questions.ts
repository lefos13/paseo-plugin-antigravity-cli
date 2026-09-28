import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { decodeArgs, type TranscriptEntry } from "./subagents";

/**
 * Relays the questions headless agy cannot ask.
 *
 * In stream-json mode agy never shows an `ask_question` dialog. It answers the call itself with
 * `A<n>: User Skipped` a few milliseconds later and the model carries on, settling the choice on its
 * own (fixtures/17-ask-question.*). The stream reports the call as a bare `unknown` step, so the
 * question itself is only in the conversation transcript:
 *
 *   {"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"ask_question",
 *    "args":{"questions":"[{\"is_multi_select\":false,\"options\":[\"Red\",\"Blue\"],
 *    \"question\":\"Which colour do you prefer?\"}]",…}}]}
 *   {"step_index":2,"type":"GENERIC","content":"Created At: …\nA1: User Skipped"}
 *
 * The stream's `unknown` step carries the index of that `GENERIC` result. The provider stops the
 * turn there and offers the questions as Paseo's question card. The answers go back as the next
 * turn of the same conversation.
 */

export const ASK_QUESTION = "ask_question";
const TRANSCRIPT_PLANNER_RESPONSE = "PLANNER_RESPONSE";
const TRANSCRIPT_GENERIC = "GENERIC";
/** What agy answers every question with when nobody is there to ask. */
const SKIPPED_MARKER = "User Skipped";
/** Sent for a question the card left unanswered, so the model can tell it apart from an answer. */
export const NO_ANSWER = "(no answer)";

export interface AgyQuestion {
  readonly question: string;
  readonly options: readonly string[];
  readonly multiSelect: boolean;
}

export interface SkippedQuestion {
  /** The stream step index of the `ask_question` call: its result's `GENERIC` transcript entry. */
  readonly callStep: number;
  readonly questions: readonly AgyQuestion[];
}

/**
 * The `ask_question` call whose result is the transcript entry at `callStep`, when agy answered it
 * with "User Skipped". Only that step is looked at: the call it names is the one the stream just
 * reported, so a question from an earlier turn of a resumed conversation can never match.
 */
export function findSkippedQuestion(
  entries: readonly TranscriptEntry[],
  callStep: number,
): SkippedQuestion | null {
  const result = entries.find((entry) => entry.stepIndex === callStep);
  if (!result || result.type !== TRANSCRIPT_GENERIC || !result.content?.includes(SKIPPED_MARKER)) {
    return null;
  }
  let planner: TranscriptEntry | null = null;
  for (const entry of entries) {
    if (entry.type !== TRANSCRIPT_PLANNER_RESPONSE || entry.stepIndex >= callStep) continue;
    if (planner === null || entry.stepIndex > planner.stepIndex) planner = entry;
  }
  const call = planner?.toolCalls.find((candidate) => candidate.name === ASK_QUESTION);
  if (!call) return null;
  const questions = readQuestions(decodeArgs(call.args).parameters.questions);
  return questions.length > 0 ? { callStep, questions } : null;
}

function readQuestions(value: unknown): AgyQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: AgyQuestion[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string" || record.question.trim().length === 0) continue;
    questions.push({
      question: record.question,
      options: Array.isArray(record.options)
        ? record.options.filter((option): option is string => typeof option === "string")
        : [],
      multiSelect: record.is_multi_select === true,
    });
  }
  return questions;
}

/** The card's key for each question: Paseo returns every answer under its question's header. */
function header(index: number): string {
  return `Question ${index + 1}`;
}

/** Paseo's question card for the questions agy skipped. */
export function questionRequest(id: string, questions: readonly AgyQuestion[]): ProviderPermissionRequest {
  return {
    id,
    name: ASK_QUESTION,
    kind: "question",
    title: questions[0]?.question ?? "Question",
    input: {
      questions: questions.map((question, index) => ({
        question: question.question,
        header: header(index),
        options: question.options.map((label) => ({ label })),
        multiSelect: question.multiSelect,
        // agy's own dialog always offers a write-in answer.
        allowOther: true,
      })),
    },
  };
}

/**
 * One answer per question, in order. The card returns a multi-select answer as its labels joined
 * with ", " and a write-in as its text. A question left without one gets `NO_ANSWER` rather than
 * blocking the reply.
 */
export function readAnswers(
  questions: readonly AgyQuestion[],
  response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
): string[] {
  const raw = response.updatedInput?.answers;
  const answers = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  return questions.map((_, index) => {
    const answer = (answers as Record<string, unknown>)[header(index)];
    return typeof answer === "string" && answer.trim().length > 0 ? answer.trim() : NO_ANSWER;
  });
}

function pairs(questions: readonly AgyQuestion[], answers: readonly string[]): string {
  return questions.map((question, index) => `${question.question}\n${answers[index] ?? NO_ANSWER}`).join("\n\n");
}

/** What the timeline shows the user sent. */
export function answerShown(questions: readonly AgyQuestion[], answers: readonly string[]): string {
  return `Answers to your questions:\n\n${pairs(questions, answers)}`;
}

/**
 * What the CLI is sent. The conversation already holds "User Skipped" as the call's result, so the
 * model has to be told that was the CLI, not the user.
 */
export function answerPrompt(questions: readonly AgyQuestion[], answers: readonly string[]): string {
  return (
    'Your ask_question call returned "User Skipped" because this Antigravity CLI runs headless: the ' +
    "user never saw the question, and the turn was stopped so they could answer it. Their answers:\n\n" +
    `${pairs(questions, answers)}\n\nContinue from where you stopped, using these answers.`
  );
}

/** How a question ended, for its timeline row: still open, answered, or dismissed. */
export type QuestionResolution =
  | { readonly kind: "pending" }
  | { readonly kind: "answered"; readonly answers: readonly string[] }
  | { readonly kind: "dismissed" };

/** The timeline row of a relayed question: each question with its options, answer, or dismissal. */
export function questionRow(
  callId: string,
  questions: readonly AgyQuestion[],
  resolution: QuestionResolution,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const body =
    resolution.kind === "answered"
      ? pairs(questions, resolution.answers)
      : pairs(questions, questions.map((question) => question.options.join(", ")));
  return {
    type: "tool_call",
    id: callId,
    callId,
    name: ASK_QUESTION,
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      icon: "brain",
      text: resolution.kind === "dismissed" ? `${body}\n\nDismissed` : body,
    },
  };
}
