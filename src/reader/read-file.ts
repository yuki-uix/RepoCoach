/**
 * File reading with line slicing.
 *
 * Every read goes through fs-guard (path containment + symlink escape) and the
 * filters (blacklist, extension whitelist, size limit, binary probe). Line
 * numbers are 1-based.
 */

import { readFileSync, statSync } from "node:fs";
import {
  hasTextExtension,
  isBinaryContent,
  isPathExcluded,
  isWithinSizeLimit,
  type FileFilterOptions,
} from "./filters.js";
import { resolveInRepo } from "./fs-guard.js";

export interface FileSlice {
  content: string;
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  totalLines: number;
}

export function readFileSlice(
  rootDir: string,
  relPath: string,
  startLine?: number,
  endLine?: number,
  opts?: FileFilterOptions,
): FileSlice {
  const { resolved, realRel } = resolveInRepo(rootDir, relPath);
  const size = statSync(resolved).size;

  // Apply the path filters to both the user-supplied alias and the symlink's
  // real target, so a link like `config.ts -> .env` is refused even though the
  // alias path itself looks readable. Error messages use the user's relPath,
  // never the real target (which could leak a secret filename).
  if (isPathExcluded(relPath) || isPathExcluded(realRel)) {
    throw new Error(`File is excluded from reads: ${relPath}`);
  }
  if (!hasTextExtension(relPath) || !hasTextExtension(realRel)) {
    throw new Error(`File has no text extension: ${relPath}`);
  }
  if (!isWithinSizeLimit(size, opts?.maxFileSize)) {
    throw new Error(`File exceeds size limit: ${relPath}`);
  }

  const buf = readFileSync(resolved);
  if (isBinaryContent(buf)) {
    throw new Error(`File appears to be binary: ${relPath}`);
  }

  const lines = splitLines(buf.toString("utf8"));
  const totalLines = lines.length;
  const start = startLine ?? 1;
  const end = endLine ?? totalLines;

  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new TypeError("startLine and endLine must be integers");
  }
  if (start < 1) {
    throw new RangeError(`startLine must be >= 1, got ${start}`);
  }
  if (end < start) {
    throw new RangeError(`endLine (${end}) must be >= startLine (${start})`);
  }

  const clampedEnd = Math.min(end, totalLines);
  const content =
    start > totalLines ? "" : lines.slice(start - 1, clampedEnd).join("\n");
  return { content, startLine: start, endLine: clampedEnd, totalLines };
}

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
