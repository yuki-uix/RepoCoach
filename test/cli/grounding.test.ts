import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDecisionInvalidError } from "../../src/agent";
import { assembleSession } from "../../src/cli";
import { capturedStreams, fixtureRoot, makeDataDir, scriptedProvider, toolMessage } from "./helpers";

describe("CLI assembly", () => {
  it("unconditionally grounds evidence: fabricated claims are rejected (docs §6)", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    const fabricated = {
      evidence: [
        { path: "src/export/csv.ts", startLine: 1, endLine: 5, reason: "exports tasks as CSV" },
      ],
      assessment: "correct",
      nextAction: "show_evidence",
    };
    const provider = scriptedProvider([
      toolMessage("c1", "submit_decision", fabricated),
      toolMessage("c2", "submit_decision", fabricated),
      toolMessage("c3", "submit_decision", fabricated),
    ]);

    const asm = assembleSession({
      dataDir,
      provider,
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    const repo = await asm.reader.importRepository(fixtureRoot);
    const session = asm.store.createSession({ repositoryId: fixtureRoot, featureId: "x" });
    const { loop } = asm.buildOrchestrator(repo, session.id, "goal");

    await expect(
      loop.invoke({ phase: "trace", featureGoal: "goal", turnHistory: [] }),
    ).rejects.toThrow(AgentDecisionInvalidError);

    // Nothing fabricated was ever saved.
    expect(asm.evidenceStore.listBySession(session.id)).toEqual([]);
  });

  it("routes the fixture import to the pre-authored candidates", async () => {
    const asm = assembleSession({
      dataDir: makeDataDir(),
      config: { deepseekKey: "test-key" },
    });
    const repo = await asm.reader.importRepository(fixtureRoot);
    const candidates = asm.candidateProvider.listCandidates(repo);

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "task-creation",
      "task-validation",
      "in-memory-storage",
    ]);
  });

  it("returns a single provisional candidate for a non-fixture repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repocoach-other-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export function main(): void {}\n", "utf8");

    const asm = assembleSession({
      dataDir: makeDataDir(),
      config: { deepseekKey: "test-key" },
    });
    const repo = await asm.reader.importRepository(dir);
    const candidates = asm.candidateProvider.listCandidates(repo);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("provisional-entry-point");
    expect(candidates[0]?.entryFiles).toEqual(["src/index.ts"]);
  });
});
