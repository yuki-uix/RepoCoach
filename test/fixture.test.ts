import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(repoRoot, "fixtures");

interface CallChainEntry {
  step: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
}

interface FeatureCandidate {
  title: string;
  entryFiles: string[];
  difficulty: "intro" | "intermediate" | "advanced";
}

type Assessment = "correct" | "partial" | "incorrect" | "unknown";

interface AnswerSample {
  question: string;
  userAnswer: string;
  expectedAssessment: Assessment;
  rationale: string;
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(...segments), "utf8")) as T;
}

const callChain = readJson<CallChainEntry[]>(
  fixturesRoot,
  "expectations",
  "call-chain.json",
);
const featureCandidates = readJson<FeatureCandidate[]>(
  fixturesRoot,
  "expectations",
  "feature-candidates.json",
);
const answerSamples = readJson<AnswerSample[]>(
  fixturesRoot,
  "expectations",
  "answer-samples.json",
);

describe("fixture expectations: call-chain", () => {
  it("describes the five steps of the task creation pipeline", () => {
    expect(callChain.map((entry) => entry.step)).toEqual([
      "createTracker",
      "parseTask",
      "validate",
      "store.add",
      "format",
    ]);
  });

  for (const entry of callChain) {
    it(`references real lines containing "${entry.symbol}" for ${entry.step}`, () => {
      expect(entry.startLine).toBeGreaterThanOrEqual(1);
      expect(entry.endLine).toBeGreaterThanOrEqual(entry.startLine);

      const lines = readFileSync(join(repoRoot, entry.path), "utf8").split("\n");
      expect(entry.endLine).toBeLessThanOrEqual(lines.length);

      const range = lines.slice(entry.startLine - 1, entry.endLine).join("\n");
      expect(range).toContain(entry.symbol);
    });
  }
});

describe("fixture expectations: feature-candidates", () => {
  it("lists two or three candidates", () => {
    expect(featureCandidates.length).toBeGreaterThanOrEqual(2);
    expect(featureCandidates.length).toBeLessThanOrEqual(3);
  });

  it("has the required fields on every candidate", () => {
    for (const candidate of featureCandidates) {
      expect(candidate.title).toBeTruthy();
      expect(candidate.entryFiles.length).toBeGreaterThan(0);
      expect(["intro", "intermediate", "advanced"]).toContain(candidate.difficulty);
    }
  });
});

describe("fixture expectations: answer-samples", () => {
  it("covers each assessment bucket at least twice", () => {
    const counts = new Map<Assessment, number>();
    for (const sample of answerSamples) {
      counts.set(
        sample.expectedAssessment,
        (counts.get(sample.expectedAssessment) ?? 0) + 1,
      );
    }
    for (const bucket of ["correct", "partial", "incorrect"] as const) {
      expect(counts.get(bucket) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it("has the required fields on every sample", () => {
    for (const sample of answerSamples) {
      expect(sample.question).toBeTruthy();
      expect(sample.userAnswer).toBeTruthy();
      expect(["correct", "partial", "incorrect", "unknown"]).toContain(
        sample.expectedAssessment,
      );
      expect(sample.rationale).toBeTruthy();
    }
  });
});
