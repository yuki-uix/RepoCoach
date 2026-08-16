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
    workspaces: dedupe([
      ...parseWorkspaces(pkg.workspaces),
      ...readPnpmWorkspacePackages(rootDir, opts),
    ]),
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
 * The file is optional — a missing file returns `[]` — while a symlink escape,
 * a secret target or an oversized file is refused exactly like a `package.json`
 * one. Malformed content degrades to `[]` (see `parsePnpmWorkspacePackages`).
 */
function readPnpmWorkspacePackages(
  rootDir: string,
  opts?: FileFilterOptions,
): string[] {
  const relPath = "pnpm-workspace.yaml";
  let resolved: string;
  let realRel: string;
  try {
    ({ resolved, realRel } = resolveInRepo(rootDir, relPath));
  } catch (error) {
    if (isEnoent(error)) {
      return []; // no pnpm workspace manifest — not an error
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

/**
 * Parse the `packages:` list of a `pnpm-workspace.yaml` file.
 *
 * This is deliberately NOT a general YAML parser — it recognises only the
 * subset of YAML that workspace detection needs, and degrades to an empty list
 * on anything else rather than throwing (the file is untrusted repository data,
 * and a malformed manifest must never abort an import).
 *
 * Supported forms:
 * - block sequence:
 *       packages:
 *         - packages/*            # unquoted, single- or double-quoted
 *         - '!packages/test'       # `!` exclusions, quoted or not
 *   with `#` comments (full-line and trailing), blank lines and arbitrary
 *   indentation; the block ends at the first non-item line.
 * - inline flow sequence (single line only):
 *       packages: ['packages/*', "apps/*"]
 *       packages: [packages/*, apps/*, ]      # trailing comma allowed
 *       packages: []                          # empty list
 *   items may be unquoted, single- or double-quoted, separated by commas and
 *   arbitrary whitespace; a `#` comment after the closing `]` is allowed.
 *
 * NOT supported (degrades to `[]` rather than throwing):
 * - multi-line flow sequences (`packages: [` with items on following lines);
 * - `#` comments *inside* the `[...]` brackets;
 * - anchors, aliases, block scalars, and every other YAML feature.
 *
 * This hand-rolled parser exists to avoid a YAML dependency; its remaining
 * gaps are found one at a time. If a third gap shows up, switch to a
 * constrained YAML parser instead of patching this one further.
 */
export function parsePnpmWorkspacePackages(content: string): string[] {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const flow = parseFlowSequence(line);
    if (flow !== null) {
      return flow; // inline flow sequence (incl. `packages: []`)
    }
    if (/^packages:\s*(?:#.*)?$/.test(line)) {
      return parseBlockSequence(lines, i + 1);
    }
  }
  return [];
}

/** Parse a single-line flow sequence (`packages: [ ... ]`), or null if not one. */
function parseFlowSequence(line: string): string[] | null {
  const match = line.match(/^packages:\s*\[(.*)$/);
  if (match === null) {
    return null;
  }
  const close = findClosingBracket(match[1] ?? "");
  if (close === -1) {
    return null; // multi-line flow sequence — unsupported
  }
  return splitFlowItems((match[1] ?? "").slice(0, close));
}

/** Parse the block sequence (`packages:` followed by `- item` lines). */
function parseBlockSequence(lines: string[], start: number): string[] {
  const patterns: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue; // blank line or full-line comment
    }
    if (!/^\s+-(\s|$)/.test(line)) {
      break; // first non-item line ends the block
    }
    const value = parseListItem(line);
    if (value !== null) {
      patterns.push(value);
    }
  }
  return patterns;
}

/** Index of the first `]` outside quotes, or -1 (covers multi-line flow). */
function findClosingBracket(rest: string): number {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "]") {
      return i;
    }
  }
  return -1;
}

/** Split a flow sequence's contents by commas (quote-aware), trimming + unquoting items. */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      pushFlowItem(items, current);
      current = "";
    } else {
      current += ch;
    }
  }
  pushFlowItem(items, current);
  return items;
}

/** Push a trimmed, unquoted, non-empty flow item. */
function pushFlowItem(items: string[], raw: string): void {
  const item = unquote(raw.trim());
  if (item !== "") {
    items.push(item);
  }
}

/** Extract the scalar of one `- value` sequence item (trailing comment and quotes stripped). */
function parseListItem(line: string): string | null {
  const match = line.match(/^\s+-\s*(.*)$/);
  if (match === null) {
    return null;
  }
  const value = stripComment(match[1] ?? "").trim();
  return value === "" ? null : unquote(value);
}

/** Strip a trailing YAML comment (`#`, when preceded by whitespace), quote-aware. */
function stripComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]!;
    const last = value[value.length - 1]!;
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'")
    ) {
      return value.slice(1, -1);
    }
  }
  return value;
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
