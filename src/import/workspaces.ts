/**
 * Workspace resolution for monorepos.
 *
 * The root `package.json`'s `workspaces` field names globs / paths. Each actual
 * workspace is a directory that both matches one of those patterns and contains
 * its own readable `package.json`; that sub-package's summary is read through
 * the reader's `readFile` (so it passes fs-guard + filters, docs/architecture.md
 * §6) and its entry candidates are resolved relative to the workspace.
 */

import {
  extractEntryPoints,
  type Reader,
  type Repository,
  type TreeEntry,
} from "../reader/index.js";
import { resolveEntryCandidates } from "./entries.js";

export interface WorkspaceInfo {
  /** Repo-relative directory, e.g. `packages/core`. */
  path: string;
  name?: string;
  entryCandidates: string[];
}

export function resolveWorkspaces(
  reader: Reader,
  repo: Repository,
  tree: TreeEntry[],
  patterns: string[],
): WorkspaceInfo[] {
  if (patterns.length === 0) {
    return [];
  }

  const packageDirs = new Set<string>();
  for (const entry of tree) {
    if (entry.path !== "package.json" && entry.path.endsWith("/package.json")) {
      packageDirs.add(entry.path.slice(0, -"/package.json".length));
    }
  }

  const workspaces: WorkspaceInfo[] = [];
  for (const dir of [...packageDirs].sort()) {
    if (!matchesWorkspaceSet(dir, patterns)) {
      continue;
    }
    const summary = readWorkspaceSummary(reader, repo, dir);
    if (summary === null) {
      continue;
    }
    workspaces.push({
      path: dir,
      name: summary.name,
      entryCandidates: resolveEntryCandidates(summary.entryPoints, tree, dir),
    });
  }
  return workspaces;
}

function readWorkspaceSummary(
  reader: Reader,
  repo: Repository,
  dir: string,
): { name?: string; entryPoints: string[] } | null {
  try {
    const slice = reader.readFile(repo, `${dir}/package.json`);
    const pkg = JSON.parse(slice.content) as Record<string, unknown>;
    return {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      entryPoints: extractEntryPoints(pkg),
    };
  } catch {
    return null;
  }
}

/** Does a workspace directory match a `workspaces` glob / path pattern? */
export function matchesWorkspace(dir: string, pattern: string): boolean {
  return globToRegExp(pattern.replace(/^\.\//, "")).test(dir);
}

/**
 * Does a directory belong to the workspace set described by `patterns`?
 *
 * `workspaces` / `packages:` lists may mix positive globs with `!`-prefixed
 * exclusions (pnpm, npm and Yarn all support this). The semantics match pnpm:
 * a directory is a workspace when it matches at least one positive pattern and
 * is not matched by any exclusion. A list of only exclusions matches nothing —
 * there is no implicit "everything" base to subtract from — and a directory
 * matched by no positive pattern is never re-added by an exclusion.
 */
export function matchesWorkspaceSet(dir: string, patterns: string[]): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (!isExclusion(pattern) && matchesWorkspace(dir, pattern)) {
      matched = true;
    }
  }
  if (!matched) {
    return false;
  }
  for (const pattern of patterns) {
    if (isExclusion(pattern) && matchesWorkspace(dir, pattern.slice(1))) {
      return false;
    }
  }
  return true;
}

/** Is this a `!`-prefixed exclusion pattern (as opposed to a positive glob)? */
function isExclusion(pattern: string): boolean {
  return pattern.startsWith("!");
}

/**
 * Translate a workspace glob to a path-anchored regular expression.
 *
 * `*` and `?` match within a single path segment, while a whole-segment `**`
 * (globstar) matches zero or more segments. A leading globstar matches zero or
 * more leading segments, a trailing one matches zero or more trailing
 * segments, and a middle one matches zero or more segments in between. That
 * segment-wise globstar is what lets an exclusion pattern (a `test` directory
 * at any depth) match both a `test` package and its nested subdirectories.
 */
function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  let out = "^";
  let needsSlash = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "**") {
      if (i === 0 && i === segments.length - 1) {
        out += ".*"; // `**` alone — matches any path
        needsSlash = false;
      } else if (i === 0) {
        out += "(?:[^/]+/)*"; // leading `**/` — zero or more segments
        needsSlash = false;
      } else if (i === segments.length - 1) {
        out += "(?:/[^/]+)*"; // trailing `/**` — zero or more segments
        needsSlash = false;
      } else {
        out += "(?:/[^/]+)*/"; // middle `/**/` — zero or more segments
        needsSlash = false;
      }
    } else {
      if (needsSlash) {
        out += "/";
      }
      out += segmentToRegex(segment);
      needsSlash = true;
    }
  }
  return new RegExp(`${out}$`);
}

/** Translate one non-globstar path segment (`*`, `?`, literals, regex metachars escaped). */
function segmentToRegex(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}
