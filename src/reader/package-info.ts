/**
 * `package.json` summary (read-only).
 *
 * Parses the root `package.json` and returns only names/keys — scripts are
 * never executed, dependencies are never installed. Also resolves the
 * `workspaces` field for monorepo support.
 *
 * The read goes through the dual gate (§6): `resolveInRepo` (path containment
 * + realpath) and the readable-path + size filters applied to both the alias
 * and the symlink's real target. Workspaces are only parsed as the strings
 * named in `package.json`; no sub-`package.json` is ever read here.
 */

import { readFileSync, statSync } from "node:fs";
import {
  isReadablePath,
  isWithinSizeLimit,
  type FileFilterOptions,
} from "./filters.js";
import { resolveInRepo } from "./fs-guard.js";

export interface PackageInfo {
  name?: string;
  /** Script names (keys only — scripts are never run). */
  scripts: string[];
  /** Dependency names across dependencies/dev/peer/optional. */
  dependencies: string[];
  /** Workspace globs / package paths (monorepo). */
  workspaces: string[];
}

export function getPackageInfo(
  rootDir: string,
  opts?: FileFilterOptions,
): PackageInfo {
  const relPath = "package.json";
  const { resolved, realRel } = resolveInRepo(rootDir, relPath);
  const size = statSync(resolved).size;

  // Filters gate: run the readable-path check on both the requested path and
  // the symlink's real target, so `package.json -> .env` is refused even though
  // the alias itself looks readable. Size is checked separately on the target.
  if (!isReadablePath(relPath) || !isReadablePath(realRel)) {
    throw new Error(`File is not readable: ${relPath}`);
  }
  if (!isWithinSizeLimit(size, opts?.maxFileSize)) {
    throw new Error(`File exceeds size limit: ${relPath}`);
  }

  const raw = readFileSync(resolved, "utf8");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("package.json is not valid JSON");
  }

  return {
    name: typeof pkg.name === "string" ? pkg.name : undefined,
    scripts: objectKeys(pkg.scripts),
    dependencies: collectDependencyKeys(pkg),
    workspaces: parseWorkspaces(pkg.workspaces),
  };
}

function objectKeys(value: unknown): string[] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

function collectDependencyKeys(pkg: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const key of objectKeys(pkg[field])) {
      keys.add(key);
    }
  }
  return [...keys];
}

function parseWorkspaces(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "object" && value !== null) {
    const packages = (value as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((item): item is string => typeof item === "string");
    }
  }
  return [];
}
