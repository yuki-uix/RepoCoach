/**
 * Entry-file candidate resolution.
 *
 * Combines the paths a `package.json` names (`main` / `module` / `exports` /
 * `bin`, already extracted by package-info's `extractEntryPoints`) with a fixed
 * list of conventional entry paths. Each path is normalised, expanded to its
 * TypeScript twin (`.js` → `.ts`) so a compiled-path manifest can still find the
 * source, deduped, and kept only when it is actually present in the reader's
 * tree. A `scopeDir` narrows resolution to one workspace package.
 */

import type { TreeEntry } from "../reader/index.js";

/** Conventional entry paths, in descending priority. */
export const CONVENTIONAL_ENTRIES = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/index.mjs",
  "index.ts",
  "index.js",
  "src/main.ts",
  "src/main.js",
];

/** Resolve the entry files for a package (or the repo root when `scopeDir` is unset). */
export function resolveEntryCandidates(
  packageEntryPoints: string[],
  tree: TreeEntry[],
  scopeDir?: string,
): string[] {
  const prefix = scopeDir === undefined || scopeDir === "" ? "" : `${scopeDir}/`;
  const treePaths = new Set(tree.map((entry) => entry.path));
  const seen = new Set<string>();

  const packagePaths = packageEntryPoints
    .map(normalizeEntryPath)
    .filter((path): path is string => path !== null)
    .map((path) => prefix + path);
  const conventionalPaths = CONVENTIONAL_ENTRIES.map((path) => prefix + path);

  const result: string[] = [];
  for (const candidate of [...packagePaths, ...conventionalPaths]) {
    for (const variant of expandVariants(candidate)) {
      if (seen.has(variant)) {
        continue;
      }
      seen.add(variant);
      if (treePaths.has(variant)) {
        result.push(variant);
      }
    }
  }
  return result;
}

/** Normalise a manifest entry path; reject empty / escaping paths. */
function normalizeEntryPath(path: string): string | null {
  let value = path.trim();
  if (value === "") {
    return null;
  }
  const query = value.search(/[?#]/);
  if (query !== -1) {
    value = value.slice(0, query);
  }
  while (value.startsWith("./")) {
    value = value.slice(2);
  }
  while (value.startsWith("/")) {
    value = value.slice(1);
  }
  if (value === "" || value.startsWith("../") || value.split("/").includes("..")) {
    return null;
  }
  return value;
}

/** The path plus its TypeScript source variant(s), if any. */
function expandVariants(path: string): string[] {
  const variants = [path];
  const replacements: Array<[string, string]> = [
    [".js", ".ts"],
    [".mjs", ".ts"],
    [".cjs", ".ts"],
    [".jsx", ".tsx"],
  ];
  for (const [from, to] of replacements) {
    if (path.endsWith(from)) {
      variants.push(path.slice(0, -from.length) + to);
    }
  }
  return variants;
}
