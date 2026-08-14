import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepositoryImport, narrowToWorkspace } from "../../src/import";
import { createReader, type GitRunner, type Reader } from "../../src/reader";
import { cleanupDir, writeFiles } from "../reader/helpers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const monorepoRoot = join(repoRoot, "fixtures", "fixture-monorepo");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupDir(dir);
  }
});

function makeReader(git?: GitRunner): Reader {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-import-"));
  tempDirs.push(cacheRoot);
  return createReader({ cacheRoot, git });
}

describe("repository import errors (AC2)", () => {
  it("rejects an invalid GitHub URL with a clear message", async () => {
    const reader = makeReader();
    await expect(
      reader.importRepository("https://github.com/owner"),
    ).rejects.toThrow(/Invalid GitHub repository URL/);
  });

  it("maps a private/nonexistent clone failure without leaking git stderr", async () => {
    const git: GitRunner = async () => {
      throw new Error(
        "git ls-remote https://github.com/owner/name.git failed: " +
          "fatal: could not read Username (token=supersecret)",
      );
    };
    const reader = makeReader(git);
    const error = await reader
      .importRepository("https://github.com/owner/name")
      .catch((cause) => cause as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("仓库不存在或非公开");
    expect(error.message).toContain("https://github.com/owner/name");
    expect(error.message).toContain("RepoCoach 只支持公开仓库");
    expect(error.message).not.toContain("supersecret");
    expect(error.message).not.toContain("fatal");
  });

  it("reports a missing package.json and still resolves conventional entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repocoach-nopkg-"));
    tempDirs.push(dir);
    writeFiles(dir, { "src/index.ts": "export const x = 1;\n" });

    const reader = makeReader();
    const repo = await reader.importRepository(dir);
    const imp = buildRepositoryImport(reader, repo);

    expect(imp.packageInfo).toBeNull();
    expect(imp.packageError).toMatch(/No package\.json/);
    expect(imp.entryCandidates).toEqual(["src/index.ts"]);
  });
});

describe("monorepo import (AC3)", () => {
  it("lists both workspace packages", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(monorepoRoot);
    const imp = buildRepositoryImport(reader, repo);

    expect(imp.workspaces.map((workspace) => workspace.path).sort()).toEqual([
      "packages/cli",
      "packages/core",
    ]);
  });

  it("narrows the tree and entry candidates to the selected workspace", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(monorepoRoot);
    const imp = buildRepositoryImport(reader, repo);
    const narrowed = narrowToWorkspace(imp, "packages/core");

    expect(narrowed.entryCandidates).toEqual(["packages/core/src/index.ts"]);
    expect(
      narrowed.tree.every((entry) => entry.path.startsWith("packages/core/")),
    ).toBe(true);
  });
});
