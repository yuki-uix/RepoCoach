/**
 * Tool return ledger — the server-side record of every (path, line range) the
 * read/search tools actually returned this turn.
 *
 * Evidence grounding checks a claim against this record: a claim is grounded
 * only when its full range sits inside a single recorded range for the same
 * path. Ranges are never merged, so two adjacent reads cannot be stitched into
 * a range the model never saw as a whole. See docs/architecture.md §1.
 */

import type { Evidence } from "../domain/index.js";

interface RecordedRange {
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * Per-turn record of tool returns. Cleared at the start of every agent turn so
 * "grounded" always means "returned this turn".
 */
export class ToolReturnLedger {
  private ranges: RecordedRange[] = [];

  /** Record a (path, inclusive line range) the tools actually returned. */
  record(path: string, startLine: number, endLine: number): void {
    this.ranges.push({
      path: normalizePath(path),
      startLine,
      endLine,
    });
  }

  /**
   * True when `claim`'s (path, [startLine, endLine]) is fully contained in one
   * recorded range for the same path. A claim spanning two records is rejected
   * even when the records are adjacent (no range merging).
   */
  isGrounded(claim: Evidence): boolean {
    const path = normalizePath(claim.path);
    return this.ranges.some(
      (range) =>
        range.path === path &&
        range.startLine <= claim.startLine &&
        claim.endLine <= range.endLine,
    );
  }

  /** Clear every recorded range (start of a new turn). */
  resetTurn(): void {
    this.ranges = [];
  }
}

/** Repo paths are compared as POSIX, regardless of host separator. */
function normalizePath(path: string): string {
  return path.split("\\").join("/");
}
