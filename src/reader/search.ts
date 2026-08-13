/**
 * Local ripgrep search.
 *
 * Uses the binary bundled with `@vscode/ripgrep` (via its `rgPath` export)
 * rather than assuming a `rg` on the host PATH — the host shell's `rg` is a
 * function shim, not a real binary. Invoked with `execFile` (fixed argv, no
 * `shell: true`), JSON output mode (`--json`) so results carry exact line and
 * column numbers.
 *
 * Symlinks: ripgrep does not follow symlinks by default, and we deliberately
 * pass no `--follow` flag, so a link like `config.ts -> .env` is never
 * searched under its alias path. Do not add `--follow` without re-applying the
 * real-target filters from fs-guard to every match.
 */

import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import {
  DEFAULT_MAX_FILE_SIZE,
  EXCLUDED_DIR_NAMES,
  isReadablePath,
} from "./filters.js";

export interface SearchOptions {
  contextLines?: number;
  /** Files larger than this (bytes) are never searched. Defaults to 512 KiB. */
  maxFileSize?: number;
}

export interface SearchMatch {
  /** Repository-relative path, `/`-separated. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based byte column of the match. */
  column: number;
  matchText: string;
  contextBefore: string[];
  contextAfter: string[];
}

interface RawMatch {
  path: string;
  line: number;
  column: number;
  matchText: string;
  contextBefore: string[];
  contextAfter: string[];
}

export async function searchRepo(
  rootDir: string,
  pattern: string,
  opts: SearchOptions = {},
): Promise<SearchMatch[]> {
  const contextLines = opts.contextLines ?? 2;
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const args = [
    "--json",
    "-B",
    String(contextLines),
    "-A",
    String(contextLines),
    "--max-filesize",
    String(maxFileSize),
    ...EXCLUDED_DIR_NAMES.map((dir) => `--glob=!**/${dir}/**`),
    "--",
    pattern,
    resolve(rootDir),
  ];

  const stdout = await runRg(args);
  const root = resolve(rootDir);
  const results: SearchMatch[] = [];
  for (const match of parseJson(stdout, contextLines)) {
    const rel = relative(root, match.path).split(sep).join("/");
    // Same path/extension judgment as tree and read-file, so search never
    // surfaces a file those entry points would refuse (e.g. `.bin`).
    if (!isReadablePath(rel)) {
      continue;
    }
    results.push({ ...match, path: rel });
  }
  return results;
}

function runRg(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      rgPath,
      args,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // rg exits 1 when there are no matches — not an error here.
          const code = (error as { code?: number | string }).code;
          if (code === 1) {
            resolvePromise("");
          } else {
            reject(new Error(`rg failed: ${stderr}`));
          }
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

function parseJson(stdout: string, contextLines: number): RawMatch[] {
  const files = new Map<
    string,
    { matches: { line: number; submatches: unknown[] }[]; contexts: { line: number; text: string }[] }
  >();

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: { type: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as { type: string; data?: Record<string, unknown> };
    } catch {
      continue; // ignore non-JSON lines
    }
    const data = event.data;
    if (data === undefined) {
      continue;
    }
    const path = stringField(data.path);
    if (path === undefined) {
      continue;
    }
    let file = files.get(path);
    if (file === undefined) {
      file = { matches: [], contexts: [] };
      files.set(path, file);
    }
    if (event.type === "match") {
      const lineNumber = data.line_number;
      const submatches = Array.isArray(data.submatches) ? data.submatches : [];
      if (typeof lineNumber === "number" && submatches.length > 0) {
        file.matches.push({ line: lineNumber, submatches });
      }
    } else if (event.type === "context") {
      const lineNumber = data.line_number;
      const text = stringField(data.lines);
      if (typeof lineNumber === "number" && text !== undefined) {
        file.contexts.push({ line: lineNumber, text: stripNewline(text) });
      }
    }
  }

  const results: RawMatch[] = [];
  for (const [path, file] of files) {
    for (const match of file.matches) {
      const contextBefore = file.contexts
        .filter((c) => c.line < match.line && c.line >= match.line - contextLines)
        .slice(-contextLines)
        .map((c) => c.text);
      const contextAfter = file.contexts
        .filter((c) => c.line > match.line && c.line <= match.line + contextLines)
        .slice(0, contextLines)
        .map((c) => c.text);
      for (const submatch of match.submatches) {
        const parsed = parseSubmatch(submatch);
        if (parsed !== undefined) {
          results.push({
            path,
            line: match.line,
            column: parsed.column,
            matchText: parsed.matchText,
            contextBefore,
            contextAfter,
          });
        }
      }
    }
  }
  return results;
}

function parseSubmatch(
  submatch: unknown,
): { column: number; matchText: string } | undefined {
  if (typeof submatch !== "object" || submatch === null) {
    return undefined;
  }
  const sm = submatch as {
    start?: unknown;
    match?: unknown;
  };
  const matchText = stringField(sm.match);
  if (typeof sm.start !== "number" || matchText === undefined) {
    return undefined;
  }
  return { column: sm.start + 1, matchText };
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function stripNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}
