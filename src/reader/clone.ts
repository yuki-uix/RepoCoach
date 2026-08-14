/**
 * Shallow clone / checkout of a repository.
 *
 * The only subprocess used anywhere in the reader is `git`, invoked here via
 * `child_process.execFile` with a fixed argv array. `shell` is never enabled,
 * so no shell interpolation is possible, and no repository script is ever
 * executed. See docs/architecture.md §3 and §6 for the boundary this upholds.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isPathExcluded, isReadablePath } from "./filters.js";
import { getTree } from "./tree.js";
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
    // Local paths are used directly (fixtures / eval) — no clone, no cache,
    // except when the tree can be pinned to a SHA. Recording and consumption
    // are symmetric: both read the same immutable clone whenever a SHA exists.
    //   - recording (opts.ref undefined): `headSha` resolves a SHA only for a
    //     clean git repo root (no staged/modified/untracked files, no readable
    //     ignored files). When it does, the first analysis reads that pinned
    //     clone — a later working-tree edit can no longer change what the
    //     session analyses. When it returns "" (subdirectory, non-git path,
    //     dirty tree, readable ignored files), we keep working-tree semantics
    //     with no pin (the honest degradation is unchanged).
    //   - consumption (opts.ref set): a resume must import the saved SHA, so we
    //     clone-and-checkout it. The only precondition is that the path is a git
    //     repo root; a tree that became dirty after the session was recorded
    //     must NOT silently fall back to the working tree.
    if (opts.ref === undefined) {
      const sha = await headSha(source.path, git);
      return sha === ""
        ? { rootDir: source.path, sha }
        : cloneLocalAtRef(source.path, sha, opts.cacheRoot, git);
    }
    if (!(await isGitRoot(source.path, git))) {
      throw new Error(
        `Cannot resume local path "${source.path}" at ref "${opts.ref}": ` +
          `not a git repository root`,
      );
    }
    return cloneLocalAtRef(source.path, opts.ref, opts.cacheRoot, git);
  }

  const url = opts.url ?? `https://github.com/${source.owner}/${source.name}.git`;
  const ref = opts.ref ?? source.ref;
  if (ref !== undefined) {
    assertSafeRef(ref);
  }
  const resolvedSha = await resolveRef(url, ref, git);

  await mkdir(opts.cacheRoot, { recursive: true });
  // Layered owner/name/sha so no pair of (owner, name) values can collide by
  // string concatenation (e.g. "foo-bar"/"baz" vs "foo"/"bar-baz").
  const cacheDir = join(opts.cacheRoot, source.owner, source.name, resolvedSha);

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

/**
 * Pin a local git-repo root to a ref via a cheap local clone. A local clone
 * shares objects with its source (hardlinks), so it is fast and carries the
 * full history; checking out the SHA is therefore a plain detached `git
 * checkout`, not the shallow fetch dance used for HTTP remotes.
 */
async function cloneLocalAtRef(
  sourcePath: string,
  ref: string,
  cacheRoot: string,
  git: GitRunner,
): Promise<CloneResult> {
  assertSafeRef(ref);
  const sha = FULL_SHA_RE.test(ref)
    ? ref.toLowerCase()
    : (await git(["rev-parse", ref], sourcePath)).trim();
  await mkdir(cacheRoot, { recursive: true });
  // A distinct "local" owner segment keeps these checkouts out of the
  // owner/name/sha namespace used for GitHub clones; the source path is hashed
  // so the cache key never depends on (or leaks) an arbitrary local path.
  const cacheDir = join(cacheRoot, "local", localKey(sourcePath), sha);
  if (await isNonEmptyDir(cacheDir)) {
    return { rootDir: cacheDir, sha };
  }
  await git(["clone", sourcePath, cacheDir]);
  await git(["checkout", "--detach", sha], cacheDir);
  return { rootDir: cacheDir, sha };
}

/** A stable, collision-resistant cache key for a local source path. */
function localKey(sourcePath: string): string {
  return createHash("sha1").update(sourcePath).digest("hex");
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Is `path` itself the root of a git repository? Only the top-level comparison
 * is made here (`git rev-parse --show-toplevel` resolving to `path`); there is
 * no cleanliness judgment — a dirty root is still a root.
 */
async function isGitRoot(path: string, git: GitRunner): Promise<boolean> {
  try {
    const topLevel = (await git(["rev-parse", "--show-toplevel"], path)).trim();
    return (await realpath(topLevel)) === (await realpath(path));
  } catch {
    return false;
  }
}

/**
 * Resolve a pin for a local path, or "" when the path has no reproducible
 * commit to pin (recording only). A clean git repo root is pinnable only when
 * the working tree holds exactly what HEAD reproduces: no staged, modified, or
 * untracked files, and no readable ignored files (the tree walker does not read
 * .gitignore, so a readable ignored text file would be analysed from the
 * working tree yet absent from a pinned clone). A subdirectory of a repo (or a
 * non-git path) has no stable pin. The SHA is returned only when every check
 * passed at that instant.
 */
async function headSha(rootDir: string, git: GitRunner): Promise<string> {
  try {
    if (!(await isGitRoot(rootDir, git))) {
      return "";
    }
    // `--porcelain` is empty exactly when nothing is staged, modified, or
    // untracked — the only state a HEAD SHA faithfully reproduces.
    if ((await git(["status", "--porcelain"], rootDir)).trim() !== "") {
      return "";
    }
    if (await hasReadableIgnoredFiles(rootDir, git)) {
      return "";
    }
    return (await git(["rev-parse", "HEAD"], rootDir)).trim();
  } catch {
    return "";
  }
}

/**
 * Whether the working tree contains an ignored file the Reader would actually
 * read. `git status` does not report ignored files by default, but the tree
 * walker ignores .gitignore and reads readable ignored text files (e.g. a
 * generated.ts), so such a file would be analysed from the working tree yet
 * absent from a pinned clone — evidence and pinned content would disagree.
 * Excluded directories (node_modules/, dist/, …) and unreadable ignored files
 * are skipped, so a repo that merely has an ignored node_modules/ still pins.
 */
async function hasReadableIgnoredFiles(
  rootDir: string,
  git: GitRunner,
): Promise<boolean> {
  const out = await git(
    ["status", "--porcelain", "--ignored=matching"],
    rootDir,
  );
  for (const line of out.split("\n")) {
    const entry = parseIgnoredEntry(line);
    if (entry === null) continue;
    if (entry.isDir) {
      // The Reader descends into any directory it does not exclude, so a
      // readable file under it is analysed from the working tree. Reuse
      // `getTree` (the same traversal + filters as the analysis path) rather
      // than reimplementing a subset of the filters.
      if (isPathExcluded(entry.rel)) continue;
      if (getTree(join(rootDir, entry.rel)).length > 0) return true;
    } else if (isReadablePath(entry.rel)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse one `--porcelain --ignored=matching` line into an ignored entry.
 * Ignored entries are reported as `!! <path>`; a fully-ignored directory
 * carries a trailing slash, mirroring the `?? <dir>/` shape used for untracked
 * directories.
 */
function parseIgnoredEntry(
  line: string,
): { rel: string; isDir: boolean } | null {
  if (!line.startsWith("!! ")) return null;
  const raw = line.slice(3);
  if (raw === "") return null;
  if (raw.endsWith("/")) {
    return { rel: raw.slice(0, -1), isDir: true };
  }
  return { rel: raw, isDir: false };
}
