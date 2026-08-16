import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GeneratedCandidateProvider } from "../../src/cli";
import { buildRepositoryImport, narrowToWorkspace } from "../../src/import";
import { createReader, type Reader } from "../../src/reader";
import { cleanupDir } from "../reader/helpers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pnpmMonorepoRoot = join(repoRoot, "fixtures", "fixture-pnpm-monorepo");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupDir(dir);
  }
});

function makeReader(): Reader {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-pnpm-import-"));
  tempDirs.push(cacheRoot);
  return createReader({ cacheRoot });
}

describe("pnpm workspace import", () => {
  it("lists both packages declared only in pnpm-workspace.yaml", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(pnpmMonorepoRoot);
    const imp = buildRepositoryImport(reader, repo);

    expect(imp.workspaces.map((workspace) => workspace.path).sort()).toEqual([
      "packages/cli",
      "packages/core",
    ]);
  });

  it("narrows the tree and entry candidates to the selected workspace", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(pnpmMonorepoRoot);
    const imp = buildRepositoryImport(reader, repo);
    const narrowed = narrowToWorkspace(imp, "packages/core");

    expect(narrowed.entryCandidates).toEqual(["packages/core/src/index.ts"]);
    expect(
      narrowed.tree.every((entry) => entry.path.startsWith("packages/core/")),
    ).toBe(true);
  });

  it("yields real scoped candidates, not the walkthrough fallback", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(pnpmMonorepoRoot);
    const provider = new GeneratedCandidateProvider(reader);
    const candidates = await provider.listCandidates(repo, {
      workspacePath: "packages/core",
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => candidate.id === "repository-walkthrough")).toBe(
      false,
    );
    for (const candidate of candidates) {
      for (const path of candidate.entryFiles) {
        expect(path.startsWith("packages/core/")).toBe(true);
      }
    }
  });
});
