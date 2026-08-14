import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEval } from "../../src/eval/cli.js";
import { capturedStreams, fixtureRoot, repoRoot } from "../cli/helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempOut(): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-eval-out-"));
  tempDirs.push(dir);
  return join(dir, "report.json");
}

describe("eval:mock end to end", () => {
  it("drives a full mock session and emits the report", async () => {
    const streams = capturedStreams();
    const out = tempOut();

    const report = await runEval("mock", {
      repoRoot,
      repositoryPath: fixtureRoot,
      out,
      stdout: streams.stdout,
    });

    // The mock plays a perfect model: full chain, perfect assessment, and it
    // adapts its follow-up to a correct vs incorrect answer.
    expect(report.endedPhase).toBe("recap");
    expect(report.degraded).toBe(false);
    expect(report.metrics.evidencePrecision.supported).toBe(5);
    expect(report.metrics.evidencePrecision.precision).toBe(1);
    expect(report.metrics.pathAccuracy.accuracy).toBe(1);
    expect(report.metrics.adaptation.adapted).toBe(true);
    expect(report.metrics.hallucination.missing).toEqual([]);

    // The judge mode reuses the same perfect mock, so agreement is 1.
    expect(report.judge.agreement).toBe(1);
    expect(report.judge.total).toBeGreaterThan(0);

    // Human report on stdout shows both eval sections.
    const outText = streams.stdoutText();
    expect(outText).toContain("RepoCoach Eval Report (mock)");
    expect(outText).toContain("Live session (evidence-grounded questioning)");
    expect(outText).toContain("Evidence precision");
    expect(outText).toContain("Judge mode (isolated assessment agreement)");

    // Machine-readable JSON written to disk with a stable shape, including the
    // full run for post-hoc diagnosis.
    const json = JSON.parse(readFileSync(out, "utf8"));
    expect(json.mode).toBe("mock");
    expect(Object.keys(json.metrics)).toEqual([
      "evidencePrecision",
      "pathAccuracy",
      "adaptation",
      "hallucination",
      "cost",
    ]);
    expect(Array.isArray(json.run.turns)).toBe(true);
    expect(json.run.turns.length).toBeGreaterThan(0);
    expect(json.run.usage).toEqual({ inputTokens: 8, outputTokens: 8 });
    expect(json.judge.agreement).toBe(1);
  });

  it("records deterministic token usage from the mock", async () => {
    const streams = capturedStreams();

    const report = await runEval("mock", {
      repoRoot,
      repositoryPath: fixtureRoot,
      stdout: streams.stdout,
      out: tempOut(),
    });

    // The mock makes exactly 8 provider calls over the primary session (1 in /
    // 1 out token each): orientation, hypothesis ask, hypothesis→trace, trace
    // (read + submit), questioning ask, questioning→feedback, feedback→recap.
    expect(report.metrics.cost.inputTokens).toBe(8);
    expect(report.metrics.cost.outputTokens).toBe(8);
    expect(report.metrics.cost.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});
