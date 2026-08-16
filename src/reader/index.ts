/**
 * Repository Reader — public entry point.
 *
 * Composes the reader modules into a single `Reader` interface:
 * URL parsing → shallow clone (cached by (repo, sha)) → optional GitHub
 * metadata, then read-only tree / search / file-read / package-info access.
 * See docs/architecture.md §3 and docs/mvp-spec.md §5.1.
 */

import { resolve } from "node:path";
import { cloneRepo, type GitRunner } from "./clone.js";
import {
  DEFAULT_MAX_FILE_SIZE,
  type FileFilterOptions,
} from "./filters.js";
import { getPackageInfo, type PackageInfo } from "./package-info.js";
import {
  getRepoMeta,
  type FetchLike,
  type RepoMeta,
} from "./github-meta.js";
import {
  getTree as walkTree,
  type TreeEntry,
} from "./tree.js";
import {
  searchRepo as runSearch,
  type SearchMatch,
} from "./search.js";
import {
  readFileSlice as readSlice,
  type FileSlice,
} from "./read-file.js";
import { parseRepoUrl, type ParsedRepoUrl } from "./url.js";

export interface ReaderOptions {
  /** Root directory under which cloned repos are cached. */
  cacheRoot: string;
  maxFileSize?: number;
  /** Number of context lines returned around search matches (default 2). */
  contextLines?: number;
  /** Test seam — inject the git runner. */
  git?: GitRunner;
  /** Test seam — inject fetch for GitHub metadata. */
  fetchFn?: FetchLike;
}

export interface Repository {
  source: ParsedRepoUrl;
  rootDir: string;
  sha: string;
  meta: RepoMeta | null;
}

export interface Reader {
  importRepository(input: string, ref?: string): Promise<Repository>;
  getTree(repo: Repository, opts?: FileFilterOptions): TreeEntry[];
  search(
    repo: Repository,
    pattern: string,
    opts?: { contextLines?: number },
  ): Promise<SearchMatch[]>;
  readFile(
    repo: Repository,
    relPath: string,
    startLine?: number,
    endLine?: number,
  ): FileSlice;
  getPackageInfo(repo: Repository): PackageInfo;
}

export function createReader(options: ReaderOptions): Reader {
  const cacheRoot = resolve(options.cacheRoot);
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const contextLines = options.contextLines ?? 2;

  return {
    async importRepository(input, ref) {
      const source = parseRepoUrl(input);
      let rootDir: string;
      let sha: string;
      try {
        ({ rootDir, sha } = await cloneRepo(source, {
          cacheRoot,
          ref,
          git: options.git,
        }));
      } catch (error) {
        if (source.kind === "github") {
          throw friendlyCloneError(source, error);
        }
        throw error;
      }
      const meta =
        source.kind === "github"
          ? await getRepoMeta(source.owner, source.name, {
              fetchFn: options.fetchFn,
            })
          : null;
      return { source, rootDir, sha, meta };
    },

    getTree(repo, opts) {
      return walkTree(repo.rootDir, { maxFileSize, ...opts });
    },

    search(repo, pattern, opts) {
      return runSearch(repo.rootDir, pattern, {
        contextLines: opts?.contextLines ?? contextLines,
        maxFileSize,
      });
    },

    readFile(repo, relPath, startLine, endLine) {
      return readSlice(repo.rootDir, relPath, startLine, endLine, {
        maxFileSize,
      });
    },

    getPackageInfo(repo) {
      return getPackageInfo(repo.rootDir, { maxFileSize });
    },
  };
}

/**
 * Map a GitHub clone failure to a clear, credential-safe user error.
 *
 * A private / nonexistent repository surfaces as a `git … failed: <stderr>`
 * subprocess error (auth prompt, 404, …). That raw stderr can echo a token or
 * other credentials, so it is never passed through — the public message names
 * the repository and the "public repos only" constraint instead. Ref-validation
 * and "could not resolve ref" errors are already clear and are kept verbatim.
 */
function friendlyCloneError(
  source: Extract<ParsedRepoUrl, { kind: "github" }>,
  error: unknown,
): Error {
  if (error instanceof Error && /^git /.test(error.message)) {
    return new Error(
      `仓库不存在或非公开：https://github.com/${source.owner}/${source.name}（RepoCoach 只支持公开仓库）`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export { parseRepoUrl } from "./url.js";
export { cloneRepo } from "./clone.js";
export { resolveInRepo } from "./fs-guard.js";
export * from "./filters.js";
export { getTree } from "./tree.js";
export { searchRepo } from "./search.js";
export { readFileSlice } from "./read-file.js";
export {
  extractEntryPoints,
  getPackageInfo,
  parsePnpmWorkspacePackages,
} from "./package-info.js";
export {
  SOURCE_FILE_RE,
  escapeRegExp,
  extractSymbolNames,
  wordIn,
} from "./symbols.js";
export { getRepoMeta } from "./github-meta.js";

export type { ParsedRepoUrl } from "./url.js";
export type { CloneOptions, CloneResult, GitRunner } from "./clone.js";
export type { FileFilterOptions } from "./filters.js";
export type { TreeEntry } from "./tree.js";
export type { SearchMatch, SearchOptions } from "./search.js";
export type { FileSlice } from "./read-file.js";
export type { PackageInfo } from "./package-info.js";
export type { FetchLike, GitHubMetaOptions, RepoMeta } from "./github-meta.js";
