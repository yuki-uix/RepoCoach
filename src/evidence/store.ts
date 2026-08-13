/**
 * Evidence Store — in-memory record of grounded evidence, keyed by session and
 * turn, plus the ability to fetch the original source lines (with surrounding
 * context) for the recap view.
 *
 * Persistence arrives with the Session Store in issue #6; this implementation
 * is deliberately in-memory only and does not depend on that work.
 * See docs/architecture.md §3.
 */

import type { Evidence } from "../domain/index.js";
import type { Reader, Repository } from "../reader/index.js";

/** Number of context lines added above/below evidence in getSourceContext. */
const SOURCE_CONTEXT_LINES = 2;

/** Evidence saved with its session/turn association. */
export interface StoredEvidence {
  sessionId: string;
  /** 0-based index of the turn within the session. */
  turnIndex: number;
  evidence: Evidence;
}

/** Source lines backing an evidence, for the recap view. */
export interface SourceContext {
  path: string;
  /** 1-based line of the first returned line (clamped to the file). */
  startLine: number;
  /** 1-based line of the last returned line (clamped to the file). */
  endLine: number;
  totalLines: number;
  content: string;
}

export interface EvidenceStore {
  save(sessionId: string, turnIndex: number, evidence: Evidence): void;
  listBySession(sessionId: string): StoredEvidence[];
  getSourceContext(
    evidence: Evidence,
    reader: Reader,
    repo: Repository,
  ): SourceContext;
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly records: StoredEvidence[] = [];

  save(sessionId: string, turnIndex: number, evidence: Evidence): void {
    // Idempotent: re-validating evidence already saved this turn (e.g. the same
    // claim cited via both repo_save_evidence and submit_decision) must not
    // create duplicate records for the recap.
    const alreadySaved = this.records.some(
      (record) =>
        record.sessionId === sessionId &&
        record.turnIndex === turnIndex &&
        sameEvidence(record.evidence, evidence),
    );
    if (alreadySaved) {
      return;
    }
    this.records.push({ sessionId, turnIndex, evidence });
  }

  listBySession(sessionId: string): StoredEvidence[] {
    return this.records.filter((record) => record.sessionId === sessionId);
  }

  /**
   * Fetch the evidence's source lines plus `SOURCE_CONTEXT_LINES` lines of
   * context on each side, clamped to the file. Line numbers in the result are
   * the real file lines, so recap can jump straight back to the source.
   */
  getSourceContext(
    evidence: Evidence,
    reader: Reader,
    repo: Repository,
  ): SourceContext {
    const slice = reader.readFile(
      repo,
      evidence.path,
      Math.max(1, evidence.startLine - SOURCE_CONTEXT_LINES),
      evidence.endLine + SOURCE_CONTEXT_LINES,
    );
    return {
      path: evidence.path,
      startLine: slice.startLine,
      endLine: slice.endLine,
      totalLines: slice.totalLines,
      content: slice.content,
    };
  }
}

/** Structural equality for deduplicating identical evidence records. */
function sameEvidence(a: Evidence, b: Evidence): boolean {
  return (
    a.path === b.path &&
    a.startLine === b.startLine &&
    a.endLine === b.endLine &&
    a.reason === b.reason
  );
}
