import { describe, expect, it } from "vitest";
import {
  buildReport,
  renderAbComparison,
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
      evaluable: true,
    },
    pathAccuracy: {
      expected: ["src/index.ts"],
      actual: ["src/index.ts"],
      matched: 1,
      total: 1,
      accuracy: 1,
      evaluable: true,
    },
    adaptation: {
      afterCorrect: "a",
      afterIncorrect: "b",
      jaccard: 0.1,
      sameQuestion: false,
      adapted: true,
      threshold: 0.5,
      evaluable: true,
    },
    hallucination: {
      mentioned: ["createTracker"],
      missing: [],
      total: 1,
      missingCount: 0,
      ratio: 0,
      evaluable: true,
    },
    cost: { inputTokens: 8, outputTokens: 8, wallClockMs: 12 },
    ...overrides,
  };
}

function judge(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    total: 2,
    agreed: 2,
    agreement: 1,
    evaluable: true,
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
          mentioned: ["evil"],
          missing: ["evil[2Jname"],
          total: 1,
          missingCount: 1,
          ratio: 1,
          evaluable: true,
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
          evaluable: true,
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

  it("renders adaptation as not evaluable instead of adapted/not adapted", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun(),
      metrics: metrics({
        adaptation: {
          afterCorrect: "",
          afterIncorrect: "Where does the raw string get split?",
          threshold: 0.5,
          evaluable: false,
          reason: "no follow-up question after the correct answer",
        },
      }),
      judge: judge(),
    });

    const out = renderReport(report);

    expect(out).toContain("Adaptation           not evaluable (no follow-up question after the correct answer)");
    expect(out).not.toContain("adapted");
  });

  it("marks an empty run's instrumented counts as invalid instead of fabricating numbers", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun({ turns: [] }),
      metrics: metrics(),
      judge: judge(),
    });

    const out = renderReport(report);

    // Counts are not ratios: an empty run shows 0 and is flagged invalid.
    expect(out).toMatch(/Tool calls\s+0 \(run invalid\)/);
    expect(out).toMatch(/Repeated reads\s+0 \(run invalid\)/);
    expect(out).toMatch(/Carried bytes\s+0 \(run invalid\)/);
  });

  it("renders the A/B comparison table and calls out the high-variance token row", () => {
    const off = buildReport({
      mode: "real",
      run: makeEvalRun({
        repeatedReads: 5,
        toolCalls: { repo_read_file: 8, submit_decision: 7 },
        usage: { inputTokens: 180_000, outputTokens: 30 },
        wallClockMs: 1000,
        carriedBytes: [],
      }),
      metrics: metrics(),
      judge: judge(),
    });
    const on = buildReport({
      mode: "real",
      run: makeEvalRun({
        repeatedReads: 1,
        toolCalls: { repo_read_file: 5, submit_decision: 7 },
        usage: { inputTokens: 150_000, outputTokens: 30 },
        wallClockMs: 900,
        carriedBytes: [2000, 2000],
      }),
      metrics: metrics(),
      judge: judge(),
    });

    const out = renderAbComparison(off, on);

    expect(out).toContain("RepoCoach Eval A/B");
    expect(out).toContain("carry OFF");
    expect(out).toContain("carry ON");
    expect(out).toMatch(/repeatedReads\s+5\s+1/);
    expect(out).toMatch(/toolCalls \(total\)\s+15\s+12/);
    expect(out).toMatch(/input tokens\s+180000\s+150000/);
    expect(out).toMatch(/wall clock \(ms\)\s+1000\s+900/);
    expect(out).toMatch(/carried bytes\s+0\s+4000/);
    expect(out).toContain("137k-212k");
    expect(out).toContain("repeatedReads is the primary metric");
  });

  it("renders an empty denominator as not evaluable, never 0.0%", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun(),
      metrics: metrics({
        evidencePrecision: {
          supported: 0,
          total: 0,
          notApplicable: 0,
          failures: [],
          notApplicableDetails: [],
          evaluable: false,
        },
        hallucination: {
          mentioned: [],
          missing: [],
          total: 0,
          missingCount: 0,
          evaluable: false,
        },
      }),
      judge: judge({ total: 0, agreed: 0, agreement: undefined, evaluable: false, samples: [] }),
    });

    const out = renderReport(report);

    expect(out).toContain("Evidence precision   0 / 0  not evaluable");
    expect(out).toContain("Assessment agreement 0 / 0  not evaluable");
    expect(out).not.toContain("(0.0%)");
  });
});
