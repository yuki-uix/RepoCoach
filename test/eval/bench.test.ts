import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBenchMetrics,
  renderBenchReport,
  runBench,
  summarizeBenchSection,
  type BenchRunMetrics,
  type BenchSection,
} from "../../src/eval/bench.js";
import { loadAnswerSamples } from "../../src/eval/fixtures.js";
import { createMockEvalProvider } from "../../src/eval/mock-provider.js";
import { capturedStreams, fixtureRoot, repoRoot } from "../cli/helpers.js";
import { makeEvalRun } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempOut(): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-bench-out-"));
  tempDirs.push(dir);
  return join(dir, "report.json");
}

/** A temp repoRoot whose benchmarks file pins one local fixture benchmark. */
function tempBenchRoot(benchmarks: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-bench-root-"));
  tempDirs.push(dir);
  const benchmarksDir = join(dir, "fixtures", "benchmarks");
  mkdirSync(benchmarksDir, { recursive: true });
  writeFileSync(join(benchmarksDir, "real-repos.json"), JSON.stringify(benchmarks), "utf8");
  return dir;
}

function makeMetrics(overrides: Partial<BenchRunMetrics> = {}): BenchRunMetrics {
  return {
    completedQuestions: 2,
    inputTokens: 10,
    outputTokens: 4,
    providerCalls: 2,
    toolCalls: {},
    peakRequestBytes: 100,
    toolResultBytes: 50,
    compressibleBytes: 40,
    ...overrides,
  };
}

function makeSection(overrides: Partial<BenchSection> = {}): BenchSection {
  return {
    name: "zod",
    repositoryId: "repo",
    featureId: "f",
    featureGoal: "goal",
    runs: [{ run: 1, endedPhase: "recap", degraded: false, metrics: makeMetrics() }],
    summary: summarizeBenchSection([makeMetrics()]),
    ...overrides,
  };
}

describe("collectBenchMetrics", () => {
  it("derives counts/bytes from providerRequests and turnCount from the session", () => {
    const metrics = collectBenchMetrics(
      makeEvalRun({
        turnCount: 2,
        usage: { inputTokens: 10, outputTokens: 4 },
        toolCalls: { repo_read_file: 3, submit_decision: 5 },
        providerRequests: [
          { round: 0, messageCount: 2, bytes: 100, toolResultBytes: 40, compressibleBytes: 30 },
          { round: 1, messageCount: 5, bytes: 300, toolResultBytes: 200, compressibleBytes: 180 },
        ],
      }),
    );

    expect(metrics).toEqual({
      completedQuestions: 2,
      inputTokens: 10,
      outputTokens: 4,
      providerCalls: 2,
      toolCalls: { repo_read_file: 3, submit_decision: 5 },
      peakRequestBytes: 300,
      toolResultBytes: 240,
      compressibleBytes: 210,
    });
  });

  it("reports 0 peak/sum bytes when the provider was never called", () => {
    const metrics = collectBenchMetrics(makeEvalRun());
    expect(metrics.providerCalls).toBe(0);
    expect(metrics.peakRequestBytes).toBe(0);
    expect(metrics.toolResultBytes).toBe(0);
    expect(metrics.compressibleBytes).toBe(0);
  });
});

describe("summarizeBenchSection", () => {
  it("reports median/min/max over the per-run values", () => {
    const summary = summarizeBenchSection([
      makeMetrics({ completedQuestions: 2 }),
      makeMetrics({ completedQuestions: 4 }),
      makeMetrics({ completedQuestions: 9 }),
    ]);
    expect(summary.metrics.completedQuestions).toEqual({ min: 2, median: 4, max: 9 });
  });

  it("unions tool names and treats a missing tool as 0 in that run", () => {
    const summary = summarizeBenchSection([
      makeMetrics({ toolCalls: { a: 1 } }),
      makeMetrics({ toolCalls: { a: 3, b: 2 } }),
    ]);
    expect(summary.toolCalls.a).toEqual({ min: 1, median: 2, max: 3 });
    expect(summary.toolCalls.b).toEqual({ min: 0, median: 1, max: 2 });
  });
});

describe("renderBenchReport", () => {
  it("prints median/min/max columns and flags an errored run", () => {
    const report = {
      runsPerBenchmark: 1,
      benchmarks: [
        makeSection({
          runs: [{ run: 1, endedPhase: "error", degraded: false, metrics: makeMetrics() }],
        }),
      ],
    };
    const out = renderBenchReport(report);

    expect(out).toContain("RepoCoach Benchmark Report");
    expect(out).toContain("metric");
    expect(out).toContain("median");
    expect(out).toContain("min");
    expect(out).toContain("max");
    expect(out).toContain("completed questions");
    expect(out).toContain("warning: run 1 ended in error");
  });

  it("flags a degraded run and lists tool-call rows", () => {
    const report = {
      runsPerBenchmark: 1,
      benchmarks: [
        makeSection({
          runs: [{ run: 2, endedPhase: "recap", degraded: true, metrics: makeMetrics({ toolCalls: { repo_read_file: 5 } }) }],
          summary: summarizeBenchSection([makeMetrics({ toolCalls: { repo_read_file: 5 } })]),
        }),
      ],
    };
    const out = renderBenchReport(report);

    expect(out).toContain("warning: run 2 degraded");
    expect(out).toContain("tool: repo_read_file");
  });
});

describe("eval:bench end to end", () => {
  it("runs one pinned local benchmark N times through the mock and reports the spread", async () => {
    const streams = capturedStreams();
    const out = tempOut();
    const samples = loadAnswerSamples(repoRoot);
    const prediction = samples[0]!;
    const followUp = samples[7]!;
    const root = tempBenchRoot([
      {
        name: "fixture",
        repositoryId: fixtureRoot,
        featureId: "task-creation",
        featureGoal: "Task creation pipeline",
        entryFiles: ["src/index.ts"],
        answers: [prediction.userAnswer, followUp.userAnswer],
      },
    ]);

    const report = await runBench({
      repoRoot: root,
      runs: 2,
      provider: createMockEvalProvider(samples),
      stdout: streams.stdout,
      out,
    });

    expect(report.runsPerBenchmark).toBe(2);
    expect(report.benchmarks).toHaveLength(1);
    const section = report.benchmarks[0]!;

    // Each run is a full mock session: 2 questions (prediction + follow-up), 8
    // provider calls (1 in / 1 out token each), 5 reads + 7 decisions.
    expect(section.runs).toHaveLength(2);
    for (const run of section.runs) {
      expect(run.endedPhase).toBe("recap");
      expect(run.degraded).toBe(false);
      expect(run.metrics.completedQuestions).toBe(2);
    }
    expect(section.summary.metrics.completedQuestions).toEqual({ min: 2, median: 2, max: 2 });
    expect(section.summary.metrics.providerCalls).toEqual({ min: 8, median: 8, max: 8 });
    expect(section.summary.metrics.inputTokens.median).toBe(8);
    expect(section.summary.metrics.outputTokens.median).toBe(8);
    expect(section.summary.toolCalls["repo_read_file"]).toEqual({ min: 5, median: 5, max: 5 });
    expect(section.summary.toolCalls["submit_decision"]).toEqual({ min: 7, median: 7, max: 7 });
    expect(section.summary.metrics.peakRequestBytes.median).toBeGreaterThan(0);
    expect(section.summary.metrics.toolResultBytes.median).toBeGreaterThan(0);
    expect(section.summary.metrics.compressibleBytes.median).toBeGreaterThan(0);

    // The human table carries the same summary to stdout.
    const outText = streams.stdoutText();
    expect(outText).toContain("RepoCoach Benchmark Report");
    expect(outText).toContain("completed questions");
    expect(outText).toContain("peak request bytes");
    expect(outText).toContain("tool: repo_read_file");

    // The JSON keeps every run's raw values, not just the summary.
    const json = JSON.parse(readFileSync(out, "utf8"));
    expect(json.runsPerBenchmark).toBe(2);
    expect(json.benchmarks[0].runs).toHaveLength(2);
    expect(json.benchmarks[0].runs[0].metrics.providerCalls).toBe(8);
    expect(json.benchmarks[0].runs[0].metrics.toolCalls).toEqual({
      submit_decision: 7,
      repo_read_file: 5,
    });
    expect(json.benchmarks[0].summary.metrics.completedQuestions).toEqual({
      min: 2,
      median: 2,
      max: 2,
    });
  });

  it("rejects a non-positive --runs value", async () => {
    const streams = capturedStreams();
    // The runs check fires before any provider call, but a valid mock keeps the
    // assertion focused on the guard rather than the provider construction.
    await expect(
      runBench({
        repoRoot,
        runs: 0,
        stdout: streams.stdout,
        provider: createMockEvalProvider(loadAnswerSamples(repoRoot)),
      }),
    ).rejects.toThrow(/--runs must be a positive integer/);
  });
});
