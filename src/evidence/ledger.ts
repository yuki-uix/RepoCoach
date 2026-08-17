/**
 * Tool return ledger — the server-side record of every (path, line range) the
 * read/search tools actually returned this turn, plus the ranges carried into
 * this turn's context from earlier turns (the cross-turn read cache).
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
  /**
   * The within-turn provider-call round the range was recorded in (0-based).
   * Only tool returns are tagged; carried ranges keep `round: -1` and are never
   * revoked by the same-turn compression window.
   */
  round: number;
}

/**
 * Per-turn record of what the model can cite. Cleared at the start of every
 * agent turn so "grounded" always means "seen this turn" — either returned by a
 * tool this turn, or carried into this turn's context with its content.
 */
export class ToolReturnLedger {
  /** Ranges the read/search tools actually returned this turn. */
  private ranges: RecordedRange[] = [];
  /** Ranges carried into this turn's context (from the session read cache). */
  private carried: RecordedRange[] = [];
  /** The current within-turn round `record` tags new ranges with. */
  private currentRound = 0;

  /**
   * Advance the within-turn round (0-based provider-call index). The loop calls
   * this before executing each round's tool calls so `record` tags ranges with
   * the round that produced them, letting `revokeRound` later drop exactly the
   * ranges pushed out of the live window by compression (issue #36).
   */
  setRound(round: number): void {
    this.currentRound = round;
  }

  /** Record a (path, inclusive line range) the tools actually returned. */
  record(path: string, startLine: number, endLine: number): void {
    this.ranges.push({
      path: normalizePath(path),
      startLine,
      endLine,
      round: this.currentRound,
    });
  }

  /**
   * Remove every range recorded in `round`, leaving ranges recorded in other
   * rounds (and every carried range) untouched. This is the grounding half of
   * the compression window: when a round's tool results are replaced by
   * placeholder lines, their ranges stop being citable in the same breath — the
   * model no longer sees the content, so a citation would be hallucinated. The
   * revocation is per-round and per-range, never "everything on this path", so a
   * sub-range re-read in a still-live round stays citable.
   */
  revokeRound(round: number): void {
    this.ranges = this.ranges.filter((range) => range.round !== round);
  }

  /**
   * Record a range whose content was actually carried into this turn's context.
   * Only the loop calls this, for exactly the ranges it re-injected with their
   * content — never the whole cache, and never a downgraded (content-omitted)
   * range, which the model cannot cite without re-reading.
   */
  recordCarried(path: string, startLine: number, endLine: number): void {
    this.carried.push({
      path: normalizePath(path),
      startLine,
      endLine,
      round: -1,
    });
  }

  /**
   * True when this exact (path, inclusive line range) was already recorded this
   * turn. The read tool uses this to suppress a re-read of a range the model
   * has already seen (issue #23, token waste).
   */
  hasRead(path: string, startLine: number, endLine: number): boolean {
    const normalized = normalizePath(path);
    return this.ranges.some(
      (range) =>
        range.path === normalized &&
        range.startLine === startLine &&
        range.endLine === endLine,
    );
  }

  /**
   * True when this exact range was carried into the current turn's context. The
   * read tool uses this to point the model at the already-carried content
   * instead of re-sending it (issue #25).
   */
  hasCarried(path: string, startLine: number, endLine: number): boolean {
    const normalized = normalizePath(path);
    return this.carried.some(
      (range) =>
        range.path === normalized &&
        range.startLine === startLine &&
        range.endLine === endLine,
    );
  }

  /**
   * True when `claim`'s (path, [startLine, endLine]) is fully contained in one
   * recorded range for the same path — either a tool return this turn or a
   * range carried into this turn's context. A claim spanning two records is
   * rejected even when the records are adjacent (no range merging).
   */
  isGrounded(claim: Evidence): boolean {
    const path = normalizePath(claim.path);
    const contained = (range: RecordedRange): boolean =>
      range.path === path &&
      range.startLine <= claim.startLine &&
      claim.endLine <= range.endLine;
    return this.ranges.some(contained) || this.carried.some(contained);
  }

  /** Clear every recorded range (start of a new turn). */
  resetTurn(): void {
    this.ranges = [];
    this.carried = [];
    this.currentRound = 0;
  }
}

/** Repo paths are compared as POSIX, regardless of host separator. */
function normalizePath(path: string): string {
  return path.split("\\").join("/");
}
