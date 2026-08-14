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
  /**
   * Entry paths named by `main` / `module` / `exports` / `bin`, in priority
   * order. Raw package.json-relative strings (e.g. `./src/index.js`); they are
   * normalised and checked against the tree by the import layer, not here.
   */
  entryPoints: string[];
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
    entryPoints: extractEntryPoints(pkg),
  };
}

/**
 * Resolve the entry paths a package's `package.json` names: `main` and
 * `module` first, then the `.` subpath of `exports` (string form, or the
 * `import`/`default`/`require` conditions), then every `bin` target. Only the
 * raw strings are returned — no file access happens here.
 */
export function extractEntryPoints(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of ["main", "module"]) {
    const value = pkg[field];
    if (typeof value === "string" && value !== "") {
      out.push(value);
    }
  }

  const exportsValue = pkg.exports;
  if (typeof exportsValue === "string" && exportsValue !== "") {
    out.push(exportsValue);
  } else if (isRecord(exportsValue)) {
    const dot = exportsValue["."];
    if (typeof dot === "string" && dot !== "") {
      out.push(dot);
    } else if (isRecord(dot)) {
      for (const condition of ["import", "default", "require"]) {
        const value = dot[condition];
        if (typeof value === "string" && value !== "") {
          out.push(value);
        }
      }
    }
  }

  const bin = pkg.bin;
  if (typeof bin === "string" && bin !== "") {
    out.push(bin);
  } else if (isRecord(bin)) {
    for (const value of Object.values(bin)) {
      if (typeof value === "string" && value !== "") {
        out.push(value);
      }
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectKeys(value: unknown): string[] {
  if (isRecord(value)) {
    return Object.keys(value);
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
