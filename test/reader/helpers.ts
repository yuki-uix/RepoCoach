/**
 * Test helpers: build tiny git repos on the fly (via `git init` + `commit`)
 * instead of relying on committed fixtures. Uses `execFile`, mirroring the
 * reader's own subprocess policy.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

export interface TempRepo {
  dir: string;
  /** Commit SHAs in order (index 0 is the first commit). */
  commits: string[];
  /** SHA of the latest commit. */
  sha: string;
}

/**
 * Create a temporary git repo and commit `files` (rel path → content). If
 * `secondFiles` is given, a second commit is made on top, overwriting/adding
 * those files.
 */
export async function createTempRepo(
  files: Record<string, string>,
  secondFiles?: Record<string, string>,
): Promise<TempRepo> {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-repo-"));
  await runGit(["init", "-q"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);

  writeFiles(dir, files);
  await runGit(["add", "-A"], dir);
  await runGit(["commit", "-q", "-m", "init"], dir);
  const commits = [(await runGit(["rev-parse", "HEAD"], dir)).trim()];

  if (secondFiles !== undefined) {
    writeFiles(dir, secondFiles);
    await runGit(["add", "-A"], dir);
    await runGit(["commit", "-q", "-m", "second"], dir);
    commits.push((await runGit(["rev-parse", "HEAD"], dir)).trim());
  }

  return { dir, commits, sha: commits[commits.length - 1] };
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
