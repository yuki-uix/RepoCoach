import { describe, expect, it } from "vitest";
import {
  buildReport,
  renderReport,
  serializeReport,
  type ReportMetrics,
} from "../../src/eval/report.js";
import type { JudgeResult } from "../../src/eval/judge.js";
import { makeEvalRun } from "./helpers";

function metrics(overrides: Partial<ReportMetrics> = {}): ReportMetrics {
  return {
    evidencePrecision: {
      supported: 5,
      total: 5,
      notApplicable: 0,
      failures: [],
      notApplicableDetails: [],
      precision: 1,
    },
    pathAccuracy: { expected: [], actual: [], matched: 0, total: 0, accuracy: 1 },
    adaptation: {
      afterCorrect: "a",
      afterIncorrect: "b",
      jaccard: 0.1,
      sameQuestion: false,
      adapted: true,
      threshold: 0.5,
    },
    hallucination: { mentioned: [], missing: [], total: 0, missingCount: 0, ratio: 0 },
    cost: { inputTokens: 8, outputTokens: 8, wallClockMs: 12 },
    ...overrides,
  };
}

function judge(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    total: 2,
    agreed: 2,
    agreement: 1,
    disagreements: [],
    confusion: {
      correct: { correct: 2, partial: 0, incorrect: 0, unknown: 0 },
      partial: { correct: 0, partial: 0, incorrect: 0, unknown: 0 },
      incorrect: { correct: 0, partial: 0, incorrect: 0, unknown: 0 },
    },
    samples: [
      {
        annotatedQuestion: "q1",
        modelQuestion: "q1",
        answer: "a1",
        expected: "correct",
        actual: "correct",
        agreed: true,
        evidence: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        wallClockMs: 1,
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
    wallClockMs: 2,
    ...overrides,
  };
}

describe("report JSON", () => {
  it("serializes a stable shape including the full run and judge sections", () => {
    const report = buildReport({ mode: "mock", run: makeEvalRun(), metrics: metrics(), judge: judge() });
    const json = JSON.parse(serializeReport(report));

    expect(Object.keys(json).sort()).toEqual(
      [
        "degraded",
        "endedPhase",
        "featureGoal",
        "featureId",
        "judge",
        "metrics",
        "mode",
        "repositoryPath",
        "run",
      ].sort(),
    );
    expect(Object.keys(json.metrics)).toEqual([
      "evidencePrecision",
      "pathAccuracy",
      "adaptation",
      "hallucination",
      "cost",
    ]);
    expect(typeof json.metrics.evidencePrecision.precision).toBe("number");
    expect(typeof json.metrics.evidencePrecision.notApplicable).toBe("number");
    expect(typeof json.metrics.cost.wallClockMs).toBe("number");
    expect(typeof json.metrics.adaptation.adapted).toBe("boolean");
    expect(typeof json.judge.agreement).toBe("number");
    expect(typeof json.judge.confusion).toBe("object");
  });

  it("embeds the complete run (turns, usage) for post-hoc diagnosis", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun({
        turns: [
          {
            phase: "hypothesis",
            question: "what flows through?",
            userAnswer: "parse → store",
            evidence: [],
          },
        ],
        usage: { inputTokens: 7, outputTokens: 3 },
      }),
      metrics: metrics(),
      judge: judge(),
    });
    const json = JSON.parse(serializeReport(report));

    expect(json.run.turns).toHaveLength(1);
    expect(json.run.turns[0].question).toBe("what flows through?");
    expect(json.run.turns[0].userAnswer).toBe("parse → store");
    expect(json.run.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

describe("report rendering (terminal gate)", () => {
  it("strips terminal control sequences from untrusted values", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun(),
      metrics: metrics({
        hallucination: {
          mentioned: [],
          missing: ["evil[2Jname"],
          total: 1,
          missingCount: 1,
          ratio: 1,
        },
      }),
      judge: judge(),
    });

    const out = renderReport(report);

    expect(out).not.toContain("[2J");
    expect(out).toContain("evilname");
  });

  it("collapses newlines in single-line slots", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun({ repositoryPath: "repo\n## forged" }),
      metrics: metrics(),
      judge: judge(),
    });

    const out = renderReport(report);

    expect(out).not.toContain("\n## forged");
    expect(out).toContain("repo ## forged");
  });

  it("shows the not-applicable count and keeps its details for review", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun(),
      metrics: metrics({
        evidencePrecision: {
          supported: 4,
          total: 4,
          notApplicable: 1,
          failures: [],
          notApplicableDetails: [
            { path: "README.md", startLine: 3, endLine: 5, reason: "no symbol claimed", missing: [] },
          ],
          precision: 1,
        },
      }),
      judge: judge(),
    });

    const out = renderReport(report);

    expect(out).toContain("(1 not applicable)");
    expect(out).toContain("Evidence precision not applicable (no symbol claimed):");
    expect(out).toContain("README.md:3-5");
  });

  it("renders the judge confusion matrix and its annotation note", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun(),
      metrics: metrics(),
      judge: judge(),
    });

    const out = renderReport(report);

    expect(out).toContain("Judge mode (isolated assessment agreement)");
    expect(out).toContain("Assessment confusion (annotation × model):");
    expect(out).toContain("correct");
    expect(out).toContain("Note: annotations are pre-authored in fixtures/expectations/answer-samples.json");
  });

  it("shows both questions when a judge disagreement's questions diverge", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun(),
      metrics: metrics(),
      judge: judge({
        agreed: 0,
        agreement: 0,
        disagreements: [
          {
            annotatedQuestion: "annotated q",
            modelQuestion: "model q",
            answer: "a",
            expected: "correct",
            actual: "partial",
          },
        ],
      }),
    });

    const out = renderReport(report);

    expect(out).toContain('annotated "annotated q" ≠ model saw "model q"');
  });
});
