/**
 * Filesystem path guard.
 *
 * Every file read goes through `resolveInRepo`, which rejects paths that
 * escape the repository root lexically (`..` / absolute paths) and symlinks
 * whose real target lies outside the repository. It also returns the real
 * target's repo-relative path (`realRel`) so callers can apply file filters
 * to a symlink's destination, not just its alias name. See docs/architecture.md §6.
 */

import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface ResolvedPath {
  /** Absolute path inside the repo, before symlink resolution. */
  resolved: string;
  /** Real target path relative to the repo root, `/`-separated. */
  realRel: string;
}

export function resolveInRepo(rootDir: string, relPath: string): ResolvedPath {
  const root = resolve(rootDir);
  const resolved = resolve(root, relPath);
  assertContained(resolved, root, relPath);

  // Reject symlinks that point outside the repository (realpath resolves the
  // full chain; it also throws ENOENT for a missing path, which is fine).
  const real = realpathSync(resolved);
  const realRoot = realpathSync(root);
  assertContained(real, realRoot, relPath);

  // The real target's repo-relative path, so filters can refuse a link like
  // `config.ts -> .env` even though the alias path itself looks readable.
  const realRel = relative(realRoot, real).split(sep).join("/");
  return { resolved, realRel };
}

function assertContained(target: string, root: string, relPath: string): void {
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Path escapes repository root: ${relPath}`);
  }
}
