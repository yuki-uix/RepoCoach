/**
 * `package.json` summary (read-only).
 *
 * Parses the root `package.json` and returns only names/keys — scripts are
 * never executed, dependencies are never installed. Also resolves the
 * `workspaces` field for monorepo support.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PackageInfo {
  name?: string;
  /** Script names (keys only — scripts are never run). */
  scripts: string[];
  /** Dependency names across dependencies/dev/peer/optional. */
  dependencies: string[];
  /** Workspace globs / package paths (monorepo). */
  workspaces: string[];
}

export function getPackageInfo(rootDir: string): PackageInfo {
  const raw = readFileSync(join(rootDir, "package.json"), "utf8");
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
