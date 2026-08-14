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
    if (!patterns.some((pattern) => matchesWorkspace(dir, pattern))) {
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

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}
