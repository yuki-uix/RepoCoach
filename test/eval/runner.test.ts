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

  it("records tool-call counts and the instrumented read/carry fields", async () => {
    const streams = capturedStreams();

    const report = await runEval("mock", {
      repoRoot,
      repositoryPath: fixtureRoot,
      stdout: streams.stdout,
      out: tempOut(),
    });

    // The mock reads the 5-step call chain once, then submits 7 decisions.
    expect(report.run.toolCalls).toEqual({ submit_decision: 7, repo_read_file: 5 });
    expect(report.run.repeatedReads).toBe(0);
    // The mock never calls repo_save_evidence (it cites via submit_decision),
    // but the first-turn entry outline is preloaded for the fixture candidate.
    expect(report.run.saveEvidenceCalls).toBe(0);
    expect(report.run.entryOutlineBytes).toHaveLength(1);
    expect(report.run.entryOutlineBytes[0]).toBeGreaterThan(0);
    // Carry is on by default, so later turns carry the trace's reads.
    expect(report.run.carriedBytes.length).toBeGreaterThan(0);
    expect(report.run.carriedBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(0);

    const outText = streams.stdoutText();
    expect(outText).toContain("Tool calls");
    expect(outText).toContain("Repeated reads");
    expect(outText).toContain("Carried bytes");
    expect(outText).toContain("Save evidence calls");
    expect(outText).toContain("Entry outline bytes");
  });

  it("--no-carry reproduces pre-optimisation behaviour: no carried context", async () => {
    const streams = capturedStreams();

    const report = await runEval("mock", {
      repoRoot,
      repositoryPath: fixtureRoot,
      stdout: streams.stdout,
      out: tempOut(),
      carry: false,
    });

    // Same reads and decisions, but nothing is carried into later turns.
    expect(report.run.toolCalls).toEqual({ submit_decision: 7, repo_read_file: 5 });
    expect(report.run.repeatedReads).toBe(0);
    expect(report.run.carriedBytes).toEqual([]);
    // The entry outline is independent of the #25 carry switch, so it is still
    // preloaded on the first turn.
    expect(report.run.entryOutlineBytes).toHaveLength(1);
  });

  it("records provider_request payload figures and the store's turnCount", async () => {
    const streams = capturedStreams();

    const report = await runEval("mock", {
      repoRoot,
      repositoryPath: fixtureRoot,
      stdout: streams.stdout,
      out: tempOut(),
    });

    const run = report.run;
    // The mock's primary session makes exactly 8 provider calls; every request
    // carries a non-zero payload, and the trace's read call carries tool bytes.
    expect(run.providerRequests).toHaveLength(8);
    expect(run.providerRequests.every((request) => request.bytes > 0)).toBe(true);
    expect(
      run.providerRequests.reduce((sum, request) => sum + request.toolResultBytes, 0),
    ).toBeGreaterThan(0);
    expect(
      run.providerRequests.reduce((sum, request) => sum + request.compressibleBytes, 0),
    ).toBeGreaterThan(0);
    // Completed questions come from the persisted session's turnCount (prediction
    // + follow-up), not from counting the turns array.
    expect(run.turnCount).toBe(2);
  });
});
