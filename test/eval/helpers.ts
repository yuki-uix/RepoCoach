/**
 * Test helpers for the eval module: EvalRun/EvalTurn constructors and a Reader
 * bound to an in-memory temp directory (no git, no network) for the metrics
 * that read files back.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReader, type Reader, type Repository } from "../../src/reader";
import type { EvalRun, EvalTurn } from "../../src/eval/types.js";

export function makeTurn(overrides: Partial<EvalTurn> = {}): EvalTurn {
  return { phase: "questioning", question: "", evidence: [], ...overrides };
}

export function makeEvalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    repositoryPath: "/repo",
    featureId: "task-creation",
    featureGoal: "Task creation pipeline",
    turns: [],
    finalFeedback: "",
    recap: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    wallClockMs: 0,
    degraded: false,
    endedPhase: "recap",
    toolCalls: {},
    repeatedReads: 0,
    carriedBytes: [],
    saveEvidenceCalls: 0,
    entryOutlineBytes: [],
    providerRequests: [],
    turnCount: 0,
    ...overrides,
  };
}

export interface TempRepo {
  dir: string;
  reader: Reader;
  repo: Repository;
}

/** Create a reader bound to a temp dir seeded with the given files. */
export function makeTempRepo(files: Record<string, string>): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-eval-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-eval-cache-"));
  const reader = createReader({ cacheRoot });
  const repo: Repository = {
    source: { kind: "local", path: dir },
    rootDir: dir,
    sha: "test",
    meta: null,
  };
  return { dir, reader, repo };
}
