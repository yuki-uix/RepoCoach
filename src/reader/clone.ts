/**
 * Shallow clone / checkout of a repository.
 *
 * The only subprocess used anywhere in the reader is `git`, invoked here via
 * `child_process.execFile` with a fixed argv array. `shell` is never enabled,
 * so no shell interpolation is possible, and no repository script is ever
 * executed. See docs/architecture.md §3 and §6 for the boundary this upholds.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedRepoUrl } from "./url.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Characters permitted in a git refname (see docs/architecture.md §6). */
const SAFE_REF_RE = /^[A-Za-z0-9._/-]+$/;

export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

/**
 * Reject refs that `git` could parse as options or that fall outside the safe
 * refname character set. This closes the argument-injection hole where a ref
 * beginning with `-` (e.g. `--upload-pack=<cmd>`) would be treated by
 * `git ls-remote` as an option rather than a pattern.
 */
function assertSafeRef(ref: string): void {
  if (
    ref.startsWith("-") ||
    ref.includes("..") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    !SAFE_REF_RE.test(ref)
  ) {
    throw new Error(
      `Unsafe ref "${ref}": refs must not start with "-", contain "..", ` +
        `or start/end with "/", and may only contain [A-Za-z0-9._/-]`,
    );
  }
}

/**
 * Run `git` with a fixed argv array (never `shell: true`). Returns stdout.
 * This is the sole subprocess shape for git in the reader.
 */
async function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
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

export interface CloneOptions {
  /** Root directory under which per-(repo, sha) checkouts are cached. */
  cacheRoot: string;
  /** Branch or commit SHA to check out (overrides any ref parsed from the URL). */
  ref?: string;
  /** Override the clone URL (test seam — lets tests use a local git remote). */
  url?: string;
  /** Inject the git runner (test seam). */
  git?: GitRunner;
}

export interface CloneResult {
  rootDir: string;
  sha: string;
}

export async function cloneRepo(
  source: ParsedRepoUrl,
  opts: CloneOptions,
): Promise<CloneResult> {
  const git = opts.git ?? runGit;

  if (source.kind === "local") {
    // Local paths are used directly (fixtures / eval) — no clone, no cache.
    const sha = await headSha(source.path, git);
    return { rootDir: source.path, sha };
  }

  const url = opts.url ?? `https://github.com/${source.owner}/${source.name}.git`;
  const ref = opts.ref ?? source.ref;
  if (ref !== undefined) {
    assertSafeRef(ref);
  }
  const resolvedSha = await resolveRef(url, ref, git);

  await mkdir(opts.cacheRoot, { recursive: true });
  const cacheDir = join(
    opts.cacheRoot,
    `${source.owner}-${source.name}-${resolvedSha}`,
  );

  if (await isNonEmptyDir(cacheDir)) {
    return { rootDir: cacheDir, sha: resolvedSha };
  }

  await cloneAndCheckout(url, ref, cacheDir, git);
  const sha = (await git(["rev-parse", "HEAD"], cacheDir)).trim();
  return { rootDir: cacheDir, sha };
}

/** Resolve a ref (branch or `HEAD`) to a commit SHA via `git ls-remote`. */
async function resolveRef(
  url: string,
  ref: string | undefined,
  git: GitRunner,
): Promise<string> {
  if (ref !== undefined && FULL_SHA_RE.test(ref)) {
    return ref.toLowerCase();
  }
  const pattern = ref ?? "HEAD";
  const out = await git(["ls-remote", url, pattern]);
  const firstLine = out.split("\n").find((line) => line.trim() !== "");
  const sha = firstLine?.trim().split(/\s+/)[0];
  if (sha === undefined) {
    throw new Error(`Could not resolve ref "${pattern}" in ${url}`);
  }
  return sha;
}

/**
 * Clone shallowly, then (for a commit SHA) fetch that SHA and check it out.
 * A `--depth 1` clone cannot reach arbitrary history, so a SHA is resolved
 * with `git fetch origin <sha> --depth 1` instead.
 */
async function cloneAndCheckout(
  url: string,
  ref: string | undefined,
  cacheDir: string,
  git: GitRunner,
): Promise<void> {
  if (ref !== undefined && FULL_SHA_RE.test(ref)) {
    await git([...cloneBaseArgs(url), cacheDir]);
    await git(["fetch", "--depth", "1", "origin", ref], cacheDir);
    await git(["checkout", "--detach", ref], cacheDir);
  } else if (ref !== undefined) {
    await git([...cloneBaseArgs(url, ref), cacheDir]);
  } else {
    await git([...cloneBaseArgs(url), cacheDir]);
  }
}

/**
 * `--filter=blob:none` only applies to real HTTP remotes; local-path remotes
 * (used in tests) ignore/refuse partial-clone filters, so it is omitted there.
 */
function cloneBaseArgs(url: string, branch?: string): string[] {
  const args = ["clone", "--depth", "1"];
  if (/^https?:\/\//i.test(url)) {
    args.push("--filter=blob:none");
  }
  if (branch !== undefined) {
    args.push("--branch", branch);
  }
  args.push(url);
  return args;
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** Resolve the checked-out commit SHA, or "" when the path is not a git repo. */
async function headSha(rootDir: string, git: GitRunner): Promise<string> {
  try {
    return (await git(["rev-parse", "HEAD"], rootDir)).trim();
  } catch {
    return "";
  }
}
