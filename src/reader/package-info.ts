/**
 * `package.json` summary (read-only).
 *
 * Parses the root `package.json` and returns only names/keys — scripts are
 * never executed, dependencies are never installed. Also resolves the
 * `workspaces` field for monorepo support, merged with the `packages:` list of
 * a root `pnpm-workspace.yaml` (pnpm monorepos declare members there instead).
 *
 * The read goes through the dual gate (§6): `resolveInRepo` (path containment
 * + realpath) and the readable-path + size filters applied to both the alias
 * and the symlink's real target. Workspaces are only parsed as the strings
 * named in `package.json` / `pnpm-workspace.yaml`; no sub-`package.json` is
 * ever read here.
 */

import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
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
  /** Non-fatal observations, e.g. a malformed pnpm-workspace.yaml that degraded to `[]`. */
  warnings: string[];
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

  const pnpm = readPnpmWorkspacePackages(rootDir, opts);
  return {
    name: typeof pkg.name === "string" ? pkg.name : undefined,
    scripts: objectKeys(pkg.scripts),
    dependencies: collectDependencyKeys(pkg),
    workspaces: dedupe([
      ...parseWorkspaces(pkg.workspaces),
      ...pnpm.packages,
    ]),
    warnings: pnpm.warning === undefined ? [] : [pnpm.warning],
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

/**
 * Read the root `pnpm-workspace.yaml` and return its `packages:` glob list.
 *
 * pnpm declares workspace members in `pnpm-workspace.yaml` rather than the root
 * `package.json` `workspaces` field, so a pnpm monorepo (e.g. Zod) would
 * otherwise be detected as zero workspaces and fall back to the generic
 * walkthrough candidate. The read goes through the same dual gate as
 * `package.json` (§6): `resolveInRepo` + the readable-path and size filters.
 * The file is optional — a missing file returns an empty list with no warning —
 * while a symlink escape, a secret target or an oversized file is refused
 * exactly like a `package.json` one. Malformed content degrades to an empty
 * list and carries a `warning` (see `parsePnpmWorkspacePackages`).
 */
function readPnpmWorkspacePackages(
  rootDir: string,
  opts?: FileFilterOptions,
): PnpmWorkspacePackages {
  const relPath = "pnpm-workspace.yaml";
  let resolved: string;
  let realRel: string;
  try {
    ({ resolved, realRel } = resolveInRepo(rootDir, relPath));
  } catch (error) {
    if (isEnoent(error)) {
      return { packages: [] }; // no pnpm workspace manifest — not an error
    }
    throw error;
  }
  const size = statSync(resolved).size;

  if (!isReadablePath(relPath) || !isReadablePath(realRel)) {
    throw new Error(`File is not readable: ${relPath}`);
  }
  if (!isWithinSizeLimit(size, opts?.maxFileSize)) {
    throw new Error(`File exceeds size limit: ${relPath}`);
  }

  return parsePnpmWorkspacePackages(readFileSync(resolved, "utf8"));
}

interface PnpmWorkspacePackages {
  packages: string[];
  /** Why the manifest degraded to `[]` — a fixed message, never file content. */
  warning?: string;
}

/**
 * Parse the `packages:` list of a `pnpm-workspace.yaml` file.
 *
 * Workspace detection needs only the one `packages` field, so this delegates to
 * the `yaml` package and reads that single key — the rest of the document is
 * ignored. A real YAML parser is used instead of a hand-rolled subset because
 * the subset accumulated three silent gaps in a row (the file being missed
 * entirely, then single-line flow sequences + `!` exclusions, then multi-line
 * flow sequences), and each gap made a real monorepo read as "no workspaces".
 * The `yaml` package covers block and flow sequences, comments, anchors/aliases,
 * quoted scalars and every other valid form for free, so this function no
 * longer enumerates "supported" vs "unsupported" shapes.
 *
 * Failure is safe rather than fatal: the file is untrusted repository data and
 * a malformed manifest must never abort an import. A YAML syntax error, a
 * non-mapping root, a missing `packages` field, or a `packages` field that is
 * not a list all degrade to an empty list and carry a fixed `warning` — never
 * the parser's error text, which can echo the file's own content.
 */
export function parsePnpmWorkspacePackages(content: string): PnpmWorkspacePackages {
  let doc: unknown;
  try {
    // `logLevel: "error"` silences non-fatal diagnostics (e.g. "unresolved tag")
    // but still throws on real syntax errors (duplicate keys, a block sequence
    // inside a flow sequence), so a malformed manifest degrades to the
    // `warning` below instead of polluting stderr.
    doc = parseYaml(content, { logLevel: "error" });
  } catch {
    return { packages: [], warning: "pnpm-workspace.yaml is not valid YAML" };
  }
  if (!isRecord(doc)) {
    return { packages: [], warning: "pnpm-workspace.yaml must be a YAML mapping" };
  }
  const packages = doc.packages;
  if (packages === undefined) {
    return { packages: [], warning: "pnpm-workspace.yaml has no `packages` field" };
  }
  if (!Array.isArray(packages)) {
    return { packages: [], warning: "pnpm-workspace.yaml `packages` must be a list" };
  }
  // Only non-empty string globs are usable. Non-string entries (and the empty
  // string an unquoted `!` tag resolves to) are dropped — with a warning rather
  // than silently, so a negated pattern the author forgot to quote is visible.
  const globs = packages.filter(
    (item): item is string => typeof item === "string" && item !== "",
  );
  if (globs.length !== packages.length) {
    return {
      packages: globs,
      warning: "pnpm-workspace.yaml `packages` contains entries that are not glob patterns",
    };
  }
  return { packages: globs };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
