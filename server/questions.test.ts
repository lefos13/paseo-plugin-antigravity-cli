import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NO_ANSWER, findSkippedQuestion, questionRequest, readAnswers } from "./questions";
import { parseTranscriptLines } from "./subagents";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

function captured(name: string) {
  const parsed = parseTranscriptLines(readFileSync(`${fixturesDir}/${name}.transcript.jsonl`, "utf8"));
  expect(parsed.malformed).toBe(0);
  return parsed.entries;
}

describe("findSkippedQuestion", () => {
  it("reads the question agy skipped from the step the stream reported as unknown", () => {
    // fixtures/17: the stream's `unknown` DONE line is step 2, the transcript's "A1: User Skipped".
    expect(findSkippedQuestion(captured("17-ask-question"), 2)).toEqual({
      callStep: 2,
      questions: [{ question: "Which colour do you prefer?", options: ["Red", "Blue"], multiSelect: false }],
    });
  });

  it("keeps every question of one call, in order, with its own selection kind", () => {
    expect(findSkippedQuestion(captured("17b-ask-question-multi"), 2)?.questions).toEqual([
      { question: "Which fruits do you like?", options: ["Apple", "Pear", "Plum"], multiSelect: true },
      { question: "Which nickname should I use for you?", options: ["Ace", "Bee"], multiSelect: false },
    ]);
  });

  it("matches only the step it is asked about", () => {
    const entries = captured("17-ask-question");
    // Step 4 is a later tool's result in the same turn, and step 1 is the planner call itself; an
    // older question must never be re-offered when a later step is checked.
    expect(findSkippedQuestion(entries, 4)).toBeNull();
    expect(findSkippedQuestion(entries, 1)).toBeNull();
    expect(findSkippedQuestion(entries, 99)).toBeNull();
  });

  it("ignores a skipped result whose planner step called some other tool", () => {
    const entries = captured("17-ask-question").map((entry) =>
      entry.stepIndex === 1 ? { ...entry, toolCalls: [{ name: "list_tasks", args: {} }] } : entry,
    );
    expect(findSkippedQuestion(entries, 2)).toBeNull();
  });

  it("ignores an ask_question call agy answered with something other than a skip", () => {
    const entries = captured("17-ask-question").map((entry) =>
      entry.stepIndex === 2 ? { ...entry, content: "Created At: …\nA1: Blue" } : entry,
    );
    expect(findSkippedQuestion(entries, 2)).toBeNull();
  });
});

describe("the question card", () => {
  const questions = [
    { question: "Which fruits do you like?", options: ["Apple", "Pear", "Plum"], multiSelect: true },
    { question: "Which nickname should I use for you?", options: ["Ace", "Bee"], multiSelect: false },
  ];

  it("reads each answer back under the header its question was offered with", () => {
    const request = questionRequest("q1", questions);
    const headers = (request.input?.questions as Array<{ header: string }>).map((entry) => entry.header);
    // The card returns answers keyed by header, so each answer has to land on its own question.
    const answers = readAnswers(questions, {
      behavior: "allow",
      updatedInput: { answers: { [headers[1] ?? ""]: "Zed", [headers[0] ?? ""]: "Apple, Plum" } },
    });
    expect(answers).toEqual(["Apple, Plum", "Zed"]);
  });

  it("sends a question the card left unanswered as unanswered", () => {
    expect(readAnswers(questions, { behavior: "allow", updatedInput: { answers: { "Question 1": "  " } } })).toEqual([
      NO_ANSWER,
      NO_ANSWER,
    ]);
    expect(readAnswers(questions, { behavior: "allow" })).toEqual([NO_ANSWER, NO_ANSWER]);
  });
});
