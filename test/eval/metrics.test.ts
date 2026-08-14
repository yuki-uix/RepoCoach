import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTATION_THRESHOLD,
  adaptation,
  evidencePrecision,
  extractSymbolNames,
  hallucination,
  nextQuestionAfter,
  orderedPaths,
  pathAccuracy,
  questionJaccard,
  repeatedReadCount,
  sessionCost,
} from "../../src/eval/metrics.js";
import type { ReadOccurrence } from "../../src/eval/metrics.js";
import type { CallChainStep } from "../../src/eval/fixtures.js";
import { makeEvalRun, makeTempRepo, makeTurn } from "./helpers";

const SYMBOLS = ["createTracker", "parseTask", "validate", "add", "formatTask"];

const CALL_CHAIN: CallChainStep[] = [
  { step: "createTracker", path: "src/index.ts", startLine: 1, endLine: 1, symbol: "createTracker" },
  { step: "parseTask", path: "src/parse/task.ts", startLine: 1, endLine: 1, symbol: "parseTask" },
];

describe("evidencePrecision", () => {
  it("counts evidence whose range contains at least one claimed symbol", () => {
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
    expect(result.notApplicable).toBe(0);
    expect(result.precision).toBe(0.5);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.missing).toEqual(["parseTask"]);
  });

  it("supports a claim when any mentioned symbol is in the range, not every one", () => {
    // The reason discusses parseTask's output type but cites the type-definition
    // file; "ParsedTask" is in the range, so the claim is supported even though
    // the known symbol "parseTask" is not literally present there.
    const { reader, repo } = makeTempRepo({
      "src/types.ts":
        "/** A task that has been parsed. */\nexport interface ParsedTask { title: string }\n",
    });
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [
            {
              path: "src/types.ts",
              startLine: 1,
              endLine: 2,
              reason: "ParsedTask defines what parseTask must return",
            },
          ],
        }),
      ],
    });

    const result = evidencePrecision(run, reader, repo, SYMBOLS);

    expect(result.total).toBe(1);
    expect(result.supported).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("marks evidence with no claimed symbol as not applicable, outside the ratio", () => {
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
    expect(result.total).toBe(0);
    expect(result.notApplicable).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(result.notApplicableDetails[0]?.missing).toEqual([]);
  });

  it("reports not evaluable when there is no evidence at all", () => {
    const { reader, repo } = makeTempRepo({ "src/a.ts": "export const x = 1;\n" });
    const run = makeEvalRun({ turns: [] });

    const result = evidencePrecision(run, reader, repo, SYMBOLS);

    expect(result.total).toBe(0);
    expect(result.evaluable).toBe(false);
    expect(result.precision).toBeUndefined();
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

  it("matches the expected chain as a subsequence amid unrelated files", () => {
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [
            { path: "README.md", startLine: 1, endLine: 1, reason: "" },
            { path: "src/index.ts", startLine: 1, endLine: 1, reason: "" },
            { path: "src/types.ts", startLine: 1, endLine: 1, reason: "" },
            { path: "src/parse/task.ts", startLine: 1, endLine: 1, reason: "" },
          ],
        }),
      ],
    });

    const result = pathAccuracy(run, CALL_CHAIN);

    expect(result.matched).toBe(2);
    expect(result.accuracy).toBe(1);
  });

  it("penalises steps that never appear in order", () => {
    const run = makeEvalRun({
      turns: [
        makeTurn({
          evidence: [
            { path: "src/parse/task.ts", startLine: 1, endLine: 1, reason: "" },
            { path: "src/index.ts", startLine: 1, endLine: 1, reason: "" },
          ],
        }),
      ],
    });

    const result = pathAccuracy(run, CALL_CHAIN);

    // "src/index.ts" appears only after "src/parse/task.ts", so the first
    // expected step matches but the second cannot follow it in order.
    expect(result.matched).toBe(1);
    expect(result.accuracy).toBe(0.5);
  });

  it("reports not evaluable when the expected chain is empty", () => {
    const run = makeEvalRun({
      turns: [
        makeTurn({ evidence: [{ path: "src/a.ts", startLine: 1, endLine: 1, reason: "a" }] }),
      ],
    });

    const result = pathAccuracy(run, []);

    expect(result.total).toBe(0);
    expect(result.evaluable).toBe(false);
    expect(result.accuracy).toBeUndefined();
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

    expect(result.evaluable).toBe(true);
    expect(result.adapted).toBe(true);
    expect(result.jaccard).toBeLessThan(DEFAULT_ADAPTATION_THRESHOLD);
  });

  it("is not evaluable when only one run has a follow-up question", () => {
    const correctRun = makeEvalRun({
      turns: [
        makeTurn({ userAnswer: "correct" }),
        makeTurn({ question: "Who assigns a task its id?" }),
      ],
    });
    const incorrectRun = makeEvalRun({
      turns: [makeTurn({ userAnswer: "incorrect" })],
    });

    const result = adaptation(correctRun, incorrectRun, "correct", "incorrect");

    expect(result.evaluable).toBe(false);
    expect(result.adapted).toBeUndefined();
    expect(result.jaccard).toBeUndefined();
    expect(result.reason).toContain("incorrect");
  });

  it("is not evaluable when neither run has a follow-up question", () => {
    const correctRun = makeEvalRun({ turns: [makeTurn({ userAnswer: "correct" })] });
    const incorrectRun = makeEvalRun({ turns: [makeTurn({ userAnswer: "incorrect" })] });

    const result = adaptation(correctRun, incorrectRun, "correct", "incorrect");

    expect(result.evaluable).toBe(false);
    expect(result.adapted).toBeUndefined();
    expect(result.reason).toContain("correct");
    expect(result.reason).toContain("incorrect");
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

  it("ignores all-caps prose and only flags the fabricated camelCase symbol", async () => {
    const { reader, repo } = makeTempRepo({
      "src/index.ts": "export function createTracker() {}\n",
    });
    const conclusion = "The pipeline is PARSE → VALIDATE → STORE; call `exportToCsv` to export.";

    const result = await hallucination(conclusion, reader, repo);

    expect(result.missing).toEqual(["exportToCsv"]);
    expect(result.total).toBe(1);
  });

  it("reports not evaluable when no symbols are mentioned", async () => {
    const { reader, repo } = makeTempRepo({
      "src/index.ts": "export function createTracker() {}\n",
    });

    const result = await hallucination("No code here, just prose.", reader, repo);

    expect(result.total).toBe(0);
    expect(result.evaluable).toBe(false);
    expect(result.ratio).toBeUndefined();
  });

  it("resolves file-path symbols against the repo tree, not source contents", async () => {
    const { reader, repo } = makeTempRepo({
      "src/index.ts": "export const x = 1;\n",
      "src/render/format.ts": "export function format() {}\n",
    });
    const conclusion = "See src/render/format.ts for the renderer.";

    const result = await hallucination(conclusion, reader, repo);

    expect(result.missing).toEqual([]);
  });
});

describe("extractSymbolNames", () => {
  it("extracts camelCase and known lowercase symbols, not prose", () => {
    expect(extractSymbolNames("The entry calls createTracker and validate.", ["validate", "add"]))
      .toEqual(["createTracker", "validate"]);
  });

  it("skips all-caps prose but keeps CONST_NAME-shaped tokens", () => {
    expect(
      extractSymbolNames("PARSE → VALIDATE → STORE, guarded by MAX_RETRIES."),
    ).toEqual(["MAX_RETRIES"]);
  });

  it("extracts backticked and call-form identifiers, not bare prose words", () => {
    expect(
      extractSymbolNames("Call `exportToCsv` and then add()."),
    ).toEqual(["exportToCsv", "add"]);
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

describe("repeatedReadCount", () => {
  const read = (path: string, startLine: number, endLine: number, turnIndex: number): ReadOccurrence => ({
    path,
    startLine,
    endLine,
    turnIndex,
  });

  it("is 0 when every read is a distinct range", () => {
    const reads = [
      read("src/a.ts", 1, 3, 0),
      read("src/b.ts", 1, 3, 0),
      read("src/a.ts", 4, 6, 1),
    ];

    expect(repeatedReadCount(reads)).toBe(0);
  });

  it("counts each cross-turn re-read of the same range", () => {
    // src/a.ts:1-3 read in turns 0, 1 and 3 → 2 repeats; src/b.ts:1-2 read in
    // turns 0 and 2 → 1 repeat.
    const reads = [
      read("src/a.ts", 1, 3, 0),
      read("src/b.ts", 1, 2, 0),
      read("src/a.ts", 1, 3, 1),
      read("src/b.ts", 1, 2, 2),
      read("src/a.ts", 1, 3, 3),
    ];

    expect(repeatedReadCount(reads)).toBe(3);
  });

  it("ignores same-turn repeats — only distinct turns count", () => {
    // The same range read twice in turn 0 (a same-turn re-read) plus once in
    // turn 1 → exactly one cross-turn repeat.
    const reads = [
      read("src/a.ts", 1, 3, 0),
      read("src/a.ts", 1, 3, 0),
      read("src/a.ts", 1, 3, 1),
    ];

    expect(repeatedReadCount(reads)).toBe(1);
  });

  it("is 0 for an empty read sequence", () => {
    expect(repeatedReadCount([])).toBe(0);
  });

  it("normalizes backslash paths to POSIX before keying", () => {
    const reads = [
      read("src\\a.ts", 1, 3, 0),
      read("src/a.ts", 1, 3, 1),
    ];

    expect(repeatedReadCount(reads)).toBe(1);
  });
});
