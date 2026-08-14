import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assembleSession } from "../../src/cli";
import { createReader, type Reader } from "../../src/reader";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");
const monorepoRoot = join(repoRoot, "fixtures", "fixture-monorepo");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeReader(): Reader {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-assemble-"));
  tempDirs.push(cacheRoot);
  return createReader({ cacheRoot });
}

/**
 * Assemble the real default graph — crucially WITHOUT a `candidateProvider`
 * override — so `listCandidates` exercises `defaultCandidateProvider`'s routing.
 */
function assembleDefault() {
  return assembleSession({
    reader: makeReader(),
    dataDir: mkdtempSync(join(tmpdir(), "repocoach-assemble-data-")),
    repoRoot,
  });
}

describe("assembleSession default candidate routing", () => {
  it("routes fixture-repo to the pre-authored whitelist", async () => {
    const asm = assembleDefault();
    const repo = await asm.reader.importRepository(fixtureRoot);

    const candidates = await asm.candidateProvider.listCandidates(repo);

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "task-creation",
      "task-validation",
      "in-memory-storage",
    ]);
  });

  it("generates real candidates scoped to the selected monorepo workspace", async () => {
    const asm = assembleDefault();
    const repo = await asm.reader.importRepository(monorepoRoot);

    const candidates = await asm.candidateProvider.listCandidates(repo, {
      workspacePath: "packages/core",
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      // Workspace scoping is honoured — never the whole repo, and never the
      // fixture-repo whitelist (whose entries live under `src/`).
      for (const path of candidate.entryFiles) {
        expect(path.startsWith("packages/core/")).toBe(true);
      }
    }
  });
});
