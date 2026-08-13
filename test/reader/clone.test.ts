import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneRepo, type GitRunner } from "../../src/reader/clone";
import { readFileSlice } from "../../src/reader/read-file";
import { cleanupDir, createTempRepo, runGit, writeFiles } from "./helpers";

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

  it("lays out the cache as owner/name/sha to avoid concatenation collisions", async () => {
    const repo = await createTempRepo({ "a.txt": "hello\n" });
    tempDirs.push(repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const { rootDir, sha } = await cloneRepo(GITHUB_SOURCE, {
      cacheRoot,
      url: repo.dir,
      ref: repo.sha,
    });

    expect(sha).toBe(repo.sha);
    expect(rootDir).toBe(join(cacheRoot, "o", "n", sha));
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

  it("rejects a ref that looks like a git option before invoking git", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return "";
    };

    await expect(
      cloneRepo(GITHUB_SOURCE, {
        cacheRoot,
        ref: "--upload-pack=touch /tmp/pwned",
        git,
      }),
    ).rejects.toThrow("--upload-pack=touch /tmp/pwned");

    expect(calls).toHaveLength(0);
  });

  it("rejects leading dashes and path traversal", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    for (const ref of ["-evil", "a..b"]) {
      await expect(
        cloneRepo(GITHUB_SOURCE, { cacheRoot, ref }),
      ).rejects.toThrow(ref);
    }
  });

  it("accepts normal branch, tag, and SHA refs", async () => {
    const repo = await createTempRepo({ "a.txt": "hello\n" });
    tempDirs.push(repo.dir);
    await runGit(["update-ref", "refs/heads/main", repo.sha], repo.dir);
    await runGit(["update-ref", "refs/heads/feature/foo", repo.sha], repo.dir);
    await runGit(["tag", "v1.2.3", repo.sha], repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    for (const ref of ["main", "v1.2.3", "feature/foo", repo.sha]) {
      const { sha } = await cloneRepo(GITHUB_SOURCE, {
        cacheRoot,
        url: repo.dir,
        ref,
      });
      expect(sha).toBe(repo.sha);
    }
  });

  it("does not pin a local root with a readable ignored file", async () => {
    // The .gitignore is committed, so the tree is clean except for the ignored
    // file — which the tree walker would still read (it ignores .gitignore).
    const repo = await createTempRepo({
      "tracked.txt": "hello\n",
      ".gitignore": "generated.ts\n",
    });
    tempDirs.push(repo.dir);
    writeFiles(repo.dir, { "generated.ts": "export const x = 1;\n" });
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const { rootDir, sha } = await cloneRepo(
      { kind: "local", path: repo.dir },
      { cacheRoot },
    );
    expect(rootDir).toBe(repo.dir);
    expect(sha).toBe("");
  });

  it("still pins a local root whose ignored entries are excluded directories", async () => {
    const repo = await createTempRepo({
      "tracked.txt": "hello\n",
      ".gitignore": "node_modules/\n",
    });
    tempDirs.push(repo.dir);
    writeFiles(repo.dir, { "node_modules/pkg.js": "x\n" });
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const { rootDir, sha } = await cloneRepo(
      { kind: "local", path: repo.dir },
      { cacheRoot },
    );
    expect(rootDir).toBe(repo.dir);
    expect(sha).toBe(repo.sha);
  });

  it("does not pin a local root when an ignored directory holds a readable file", async () => {
    const repo = await createTempRepo({
      "tracked.txt": "hello\n",
      ".gitignore": "generated/\n",
    });
    tempDirs.push(repo.dir);
    writeFiles(repo.dir, { "generated/out.ts": "export const y = 1;\n" });
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const { rootDir, sha } = await cloneRepo(
      { kind: "local", path: repo.dir },
      { cacheRoot },
    );
    expect(rootDir).toBe(repo.dir);
    expect(sha).toBe("");
  });
});
