/**
 * Filesystem path guard.
 *
 * Every file read goes through `resolveInRepo`, which rejects paths that
 * escape the repository root lexically (`..` / absolute paths) and symlinks
 * whose real target lies outside the repository. See docs/architecture.md §6.
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export function resolveInRepo(rootDir: string, relPath: string): string {
  const root = resolve(rootDir);
  const resolved = resolve(root, relPath);
  assertContained(resolved, root, relPath);

  // Reject symlinks that point outside the repository (realpath resolves the
  // full chain; it also throws ENOENT for a missing path, which is fine).
  const real = realpathSync(resolved);
  const realRoot = realpathSync(root);
  assertContained(real, realRoot, relPath);
  return resolved;
}

function assertContained(target: string, root: string, relPath: string): void {
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Path escapes repository root: ${relPath}`);
  }
}
