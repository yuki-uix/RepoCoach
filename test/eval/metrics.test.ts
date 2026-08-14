import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTATION_THRESHOLD,
  adaptation,
  assessmentAgreement,
  evidencePrecision,
  extractSymbolNames,
  hallucination,
  nextQuestionAfter,
  orderedPaths,
  pathAccuracy,
  questionJaccard,
  sessionCost,
} from "../../src/eval/metrics.js";
import type { AnswerSample, CallChainStep } from "../../src/eval/fixtures.js";
import { makeEvalRun, makeTempRepo, makeTurn } from "./helpers";

const SYMBOLS = ["createTracker", "parseTask", "validate", "add", "formatTask"];

const CALL_CHAIN: CallChainStep[] = [
  { step: "createTracker", path: "src/index.ts", startLine: 1, endLine: 1, symbol: "createTracker" },
  { step: "parseTask", path: "src/parse/task.ts", startLine: 1, endLine: 1, symbol: "parseTask" },
];

describe("evidencePrecision", () => {
  it("counts evidence whose range contains the claimed symbol", () => {
    const { reader, repo } = makeTempRepo({
      "src/index.ts": "export function createTracker() { return parseTask(); }\n",
      "src/other.ts": "export const unused = 1;\n",
    });
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [
            { path: "src/index.ts", startLine: 1, endLine: 1, reason: "createTracker wires the entry" },
            { path: "src/other.ts", startLine: 1, endLine: 1, reason: "parseTask lives here" },
          ],
        }),
      ],
    });

    const result = evidencePrecision(run, reader, repo, SYMBOLS);

    expect(result.total).toBe(2);
    expect(result.supported).toBe(1);
    expect(result.precision).toBe(0.5);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.missing).toEqual(["parseTask"]);
  });

  it("reports unsupported when no known symbol is claimed", () => {
    const { reader, repo } = makeTempRepo({ "src/a.ts": "export const x = 1;\n" });
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [{ path: "src/a.ts", startLine: 1, endLine: 1, reason: "just a note" }],
        }),
      ],
    });

    const result = evidencePrecision(run, reader, repo, SYMBOLS);

    expect(result.supported).toBe(0);
    expect(result.failures[0]?.missing).toEqual([]);
  });
});

describe("pathAccuracy", () => {
  it("scores positionally-correct steps against the expected chain", () => {
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [
            { path: "src/index.ts", startLine: 1, endLine: 1, reason: "a" },
            { path: "src/parse/task.ts", startLine: 1, endLine: 1, reason: "b" },
          ],
        }),
      ],
    });

    const result = pathAccuracy(run, CALL_CHAIN);

    expect(result.expected).toEqual(["src/index.ts", "src/parse/task.ts"]);
    expect(result.matched).toBe(2);
    expect(result.accuracy).toBe(1);
  });

  it("penalises out-of-order steps", () => {
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [
            { path: "src/parse/task.ts", startLine: 1, endLine: 1, reason: "a" },
            { path: "src/index.ts", startLine: 1, endLine: 1, reason: "b" },
          ],
        }),
      ],
    });

    const result = pathAccuracy(run, CALL_CHAIN);

    expect(result.matched).toBe(0);
    expect(result.accuracy).toBe(0);
  });
});

describe("assessmentAgreement", () => {
  const samples: AnswerSample[] = [
    { question: "q1", userAnswer: "full chain answer", expectedAssessment: "correct", rationale: "" },
    { question: "q2", userAnswer: "wrong answer", expectedAssessment: "incorrect", rationale: "" },
  ];

  it("counts agreement over assessed sample answers", () => {
    const run = makeEvalRun({
      turns: [
        // The answer-transition turn carries the answer but no assessment.
        makeTurn({ userAnswer: "full chain answer" }),
        // The trace turn assesses the previous turn's answer (no userAnswer).
        makeTurn({ assessment: "correct" }),
        // The follow-up answer and its assessment land on the same turn.
        makeTurn({ userAnswer: "wrong answer", assessment: "partial" }),
      ],
    });

    const result = assessmentAgreement(run, samples);

    expect(result.matched).toBe(2);
    expect(result.agreed).toBe(1);
    expect(result.agreement).toBe(0.5);
    expect(result.disagreements).toHaveLength(1);
  });
});

describe("adaptation", () => {
  it("flags adaptation when the follow-up questions differ", () => {
    const correctRun = makeEvalRun({
      turns: [
        makeTurn({ userAnswer: "correct" }),
        makeTurn({ question: "Who assigns a task its id?" }),
      ],
    });
    const incorrectRun = makeEvalRun({
      turns: [
        makeTurn({ userAnswer: "incorrect" }),
        makeTurn({ question: "Where does the raw string get split into fields?" }),
      ],
    });

    const result = adaptation(correctRun, incorrectRun, "correct", "incorrect");

    expect(result.adapted).toBe(true);
    expect(result.jaccard).toBeLessThan(DEFAULT_ADAPTATION_THRESHOLD);
  });

  it("does not flag adaptation for the identical question", () => {
    const question = "Who assigns a task its id?";
    const correctRun = makeEvalRun({
      turns: [makeTurn({ userAnswer: "correct" }), makeTurn({ question })],
    });
    const incorrectRun = makeEvalRun({
      turns: [makeTurn({ userAnswer: "incorrect" }), makeTurn({ question })],
    });

    const result = adaptation(correctRun, incorrectRun, "correct", "incorrect");

    expect(result.adapted).toBe(false);
    expect(result.sameQuestion).toBe(true);
  });
});

describe("questionJaccard", () => {
  it("is 1 for identical text and 0 for disjoint tokens", () => {
    expect(questionJaccard("same words here", "same words here")).toBe(1);
    expect(questionJaccard("alpha beta", "gamma delta")).toBe(0);
  });
});

describe("nextQuestionAfter", () => {
  it("returns the first question after the answer turn", () => {
    const run = makeEvalRun({
      turns: [
        makeTurn({ question: "prediction?", userAnswer: "a" }),
        makeTurn({ evidence: [{ path: "p", startLine: 1, endLine: 1, reason: "r" }] }),
        makeTurn({ question: "follow-up?" }),
      ],
    });

    expect(nextQuestionAfter(run, "a")).toBe("follow-up?");
  });
});

describe("hallucination", () => {
  it("flags symbols mentioned but absent from source", async () => {
    const { reader, repo } = makeTempRepo({
      "src/index.ts": "export function createTracker() {}\n",
    });
    const conclusion = "The entry is createTracker, but you can also call deleteAllTasks.";

    const result = await hallucination(conclusion, reader, repo, ["createTracker", "deleteAllTasks"]);

    expect(result.missing).toEqual(["deleteAllTasks"]);
    expect(result.total).toBe(2);
    expect(result.ratio).toBe(0.5);
  });

  it("does not count a README mention as existing source", async () => {
    const { reader, repo } = makeTempRepo({
      "src/index.ts": "export function createTracker() {}\n",
      "README.md": "You can call exportToCsv.\n",
    });

    const result = await hallucination("Use exportToCsv.", reader, repo);

    expect(result.missing).toEqual(["exportToCsv"]);
  });
});

describe("extractSymbolNames", () => {
  it("extracts camelCase and known lowercase symbols, not prose", () => {
    expect(extractSymbolNames("The entry calls createTracker and validate.", ["validate", "add"]))
      .toEqual(["createTracker", "validate"]);
  });
});

describe("orderedPaths", () => {
  it("dedupes evidence paths preserving first appearance", () => {
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [
            { path: "a.ts", startLine: 1, endLine: 1, reason: "" },
            { path: "b.ts", startLine: 1, endLine: 1, reason: "" },
            { path: "a.ts", startLine: 2, endLine: 2, reason: "" },
          ],
        }),
      ],
    });

    expect(orderedPaths(run)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("sessionCost", () => {
  it("reports tokens and wall-clock", () => {
    const run = makeEvalRun({ usage: { inputTokens: 12, outputTokens: 7 }, wallClockMs: 34 });

    expect(sessionCost(run)).toEqual({ inputTokens: 12, outputTokens: 7, wallClockMs: 34 });
  });
});
