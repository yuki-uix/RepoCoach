import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneRepo, type GitRunner } from "../../src/reader/clone";
import { readFileSlice } from "../../src/reader/read-file";
import { cleanupDir, createTempRepo, runGit } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupDir(dir);
  }
});

const GITHUB_SOURCE = { kind: "github" as const, owner: "o", name: "n" };

describe("cloneRepo", () => {
  it("checks out a specific commit SHA with correct content", async () => {
    const repo = await createTempRepo(
      { "a.txt": "first\n", "b.txt": "first\n" },
      { "a.txt": "second\n", "c.txt": "added\n" },
    );
    tempDirs.push(repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const firstSha = repo.commits[0];
    const { rootDir, sha } = await cloneRepo(GITHUB_SOURCE, {
      cacheRoot,
      url: repo.dir,
      ref: firstSha,
    });

    expect(sha).toBe(firstSha);
    expect(readFileSlice(rootDir, "a.txt").content).toBe("first");
    // c.txt only exists in the second commit.
    expect(() => readFileSlice(rootDir, "c.txt")).toThrow();
  });

  it("does not clone again on a second import of the same (repo, sha)", async () => {
    const repo = await createTempRepo({ "a.txt": "hello\n" });
    tempDirs.push(repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const calls: string[][] = [];
    const git: GitRunner = async (args, cwd) => {
      calls.push(args);
      return runGit(args, cwd);
    };

    const opts = { cacheRoot, url: repo.dir, ref: repo.sha, git };
    const first = await cloneRepo(GITHUB_SOURCE, opts);
    const second = await cloneRepo(GITHUB_SOURCE, opts);

    expect(first.sha).toBe(repo.sha);
    expect(second.rootDir).toBe(first.rootDir);
    expect(calls.filter((a) => a[0] === "clone")).toHaveLength(1);
  });

  it("uses a local path directly without cloning", async () => {
    const repo = await createTempRepo({ "a.txt": "hello\n" });
    tempDirs.push(repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const { rootDir, sha } = await cloneRepo(
      { kind: "local", path: repo.dir },
      { cacheRoot },
    );
    expect(rootDir).toBe(repo.dir);
    expect(sha).toBe(repo.sha);
  });
});
