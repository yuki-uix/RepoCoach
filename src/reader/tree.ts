/**
 * Directory tree walk.
 *
 * Recursively lists readable text files under `rootDir` (after the filters in
 * filters.ts). Symlinks are never followed or returned, so a link cannot
 * escape the walk or masquerade as a readable file — even one whose alias name
 * passes the filters (`config.ts -> .env`) is simply skipped. See read-file.ts,
 * which does follow in-repo symlinks and therefore re-runs the filters against
 * the real target via fs-guard's `realRel`.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  isIncludedInTree,
  isPathExcluded,
  type FileFilterOptions,
} from "./filters.js";

export interface TreeEntry {
  /** Repository-relative path, `/`-separated. */
  path: string;
  size: number;
}

export function getTree(rootDir: string, opts?: FileFilterOptions): TreeEntry[] {
  const root = resolve(rootDir);
  const entries: TreeEntry[] = [];
  walk(root, root, entries, opts);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function walk(
  root: string,
  dir: string,
  out: TreeEntry[],
  opts?: FileFilterOptions,
): void {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) {
      continue; // never follow symlinks
    }
    const full = join(dir, dirent.name);
    const rel = relative(root, full).split(sep).join("/");
    if (dirent.isDirectory()) {
      if (isPathExcluded(rel)) {
        continue; // skip blacklisted directories entirely
      }
      walk(root, full, out, opts);
    } else if (dirent.isFile()) {
      const size = statSync(full).size;
      if (isIncludedInTree(rel, size, opts)) {
        out.push({ path: rel, size });
      }
    }
  }
}
