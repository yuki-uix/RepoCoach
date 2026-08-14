import { describe, expect, it } from "vitest";
import {
  buildReport,
  renderReport,
  serializeReport,
  type ReportMetrics,
} from "../../src/eval/report.js";
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
    assessmentAgreement: {
      matched: 2,
      agreed: 2,
      total: 2,
      agreement: 1,
      disagreements: [],
      confusion: {
        correct: { correct: 2, partial: 0, incorrect: 0, unknown: 0 },
        partial: { correct: 0, partial: 0, incorrect: 0, unknown: 0 },
        incorrect: { correct: 0, partial: 0, incorrect: 0, unknown: 0 },
      },
    },
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

describe("report JSON", () => {
  it("serializes a stable shape for before/after comparison", () => {
    const report = buildReport({ mode: "mock", run: makeEvalRun(), metrics: metrics() });
    const json = JSON.parse(serializeReport(report));

    expect(Object.keys(json).sort()).toEqual(
      ["degraded", "endedPhase", "featureGoal", "featureId", "metrics", "mode", "repositoryPath"].sort(),
    );
    expect(Object.keys(json.metrics)).toEqual([
      "evidencePrecision",
      "pathAccuracy",
      "assessmentAgreement",
      "adaptation",
      "hallucination",
      "cost",
    ]);
    expect(typeof json.metrics.evidencePrecision.precision).toBe("number");
    expect(typeof json.metrics.evidencePrecision.notApplicable).toBe("number");
    expect(typeof json.metrics.assessmentAgreement.confusion).toBe("object");
    expect(typeof json.metrics.cost.wallClockMs).toBe("number");
    expect(typeof json.metrics.adaptation.adapted).toBe("boolean");
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
    });

    const out = renderReport(report);

    expect(out).toContain("(1 not applicable)");
    expect(out).toContain("Evidence precision not applicable (no symbol claimed):");
    expect(out).toContain("README.md:3-5");
  });

  it("renders the assessment confusion matrix and its annotation note", () => {
    const report = buildReport({
      mode: "mock",
      run: makeEvalRun(),
      metrics: metrics(),
    });

    const out = renderReport(report);

    expect(out).toContain("Assessment confusion (annotation × model):");
    expect(out).toContain("correct");
    expect(out).toContain("Note: annotations are pre-authored in fixtures/expectations/answer-samples.json");
  });
});
