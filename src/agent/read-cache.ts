/**
 * Session read cache — the cross-turn record of file ranges already returned to
 * the model by repo_read_file.
 *
 * The loop rebuilds its message list every turn, so a tool result from turn N is
 * gone from context in turn N+1 and the model re-reads the same files (issue
 * #25). This cache survives across turns (unlike ToolReturnLedger, whose
 * `resetTurn` clears per-turn records) and lets the loop re-inject a bounded
 * subset of already-shown ranges into each later turn's context, with grounding
 * extended to accept only the ranges actually carried.
 *
 * It records (path, startLine, endLine, content) exactly as returned: the range
 * is the *shown* range (already clamped/truncated by the read tool), and the
 * content is the numbered lines the model saw. Search results are deliberately
 * not cached — their "content" is match snippets, not a contiguous file slice,
 * so carrying them forward as file content would be misleading; search grounding
 * stays per-turn.
 *
 * NOTE (resume tradeoff): the cache is per-session in memory only. A resumed
 * session rebuilds the loop (and this cache) empty, so the first post-resume
 * turn re-reads files. That re-read cost is accepted rather than persisting repo
 * content outside the session file.
 */

import { byteLength } from "./limits.js";

export interface CachedRange {
  path: string;
  startLine: number;
  endLine: number;
  /** The numbered lines actually returned to the model (re-injected verbatim). */
  content: string;
  /** Monotonic recency counter — larger is more recently read. */
  lastUsed: number;
  /** True once the model cited this range in an accepted decision. */
  cited: boolean;
}

export class SessionReadCache {
  private records: CachedRange[] = [];
  private tick = 0;

  /**
   * Record a shown range. Re-recording an identical (path, range) refreshes its
   * content and recency instead of growing the cache.
   */
  record(path: string, startLine: number, endLine: number, content: string): void {
    this.tick += 1;
    const normalized = normalizePath(path);
    const existing = this.records.find(
      (range) =>
        range.path === normalized &&
        range.startLine === startLine &&
        range.endLine === endLine,
    );
    if (existing) {
      existing.content = content;
      existing.lastUsed = this.tick;
      return;
    }
    this.records.push({
      path: normalized,
      startLine,
      endLine,
      content,
      lastUsed: this.tick,
      cited: false,
    });
  }

  /**
   * Mark a cited range as referenced. The citation may be a sub-range of a
   * cached range (the model saw a whole slice and cited part of it), so every
   * cached range on the same path that contains the citation is marked.
   */
  markCited(path: string, startLine: number, endLine: number): void {
    const normalized = normalizePath(path);
    for (const range of this.records) {
      if (
        range.path === normalized &&
        range.startLine <= startLine &&
        endLine <= range.endLine
      ) {
        range.cited = true;
      }
    }
  }

  get ranges(): readonly CachedRange[] {
    return this.records;
  }
}

export interface CarrySelection {
  /** Ranges carried into the next turn's context with their full content. */
  carry: CachedRange[];
  /** Ranges downgraded to path + line only (content NOT carried, not citable). */
  omitted: CachedRange[];
}

/** The formatted carried entry for one range (matches formatCarriedBlock). */
function carriedEntry(range: CachedRange): string {
  return `${range.path} (lines ${range.startLine}-${range.endLine}):\n${range.content}`;
}

/**
 * Choose which cached ranges to carry in full, up to `maxBytes` of content.
 *
 * Ordering: ranges the model has cited come first (they are the ones it keeps
 * referring back to), then most-recently-read. Ranges that do not fit are
 * downgraded — they stay listed by path + line range but their content is
 * omitted, so the model must re-read before citing them (grounding only accepts
 * carried content, never the cache as a whole).
 */
export function selectCarryRanges(
  ranges: readonly CachedRange[],
  maxBytes: number,
): CarrySelection {
  const ordered = [...ranges].sort((a, b) => {
    if (a.cited !== b.cited) {
      return a.cited ? -1 : 1;
    }
    return b.lastUsed - a.lastUsed;
  });

  const carry: CachedRange[] = [];
  const omitted: CachedRange[] = [];
  let used = 0;
  for (const range of ordered) {
    const entryBytes = byteLength(carriedEntry(range));
    // Two separator bytes between carried entries (the "\n\n" in the block).
    const separator = carry.length === 0 ? 0 : 2;
    if (used + separator + entryBytes <= maxBytes) {
      carry.push(range);
      used += separator + entryBytes;
    } else {
      omitted.push(range);
    }
  }
  return { carry, omitted };
}

/**
 * Format the carried-context block: the fixed lead line, then each carried
 * range's path/range header plus its content, then a downgraded list of
 * path + line ranges whose content was omitted. The caller wraps the result in
 * data-guard markers (repository content must never reach the system prompt).
 */
export function formatCarriedBlock(
  carry: readonly CachedRange[],
  omitted: readonly CachedRange[],
): string {
  const parts: string[] = [
    "Already-read ranges carried from earlier turns in this session. Ranges listed " +
      "with their content are already in context: cite them directly, do not re-read " +
      "them. For any other range, call repo_read_file first.",
  ];
  for (const range of carry) {
    parts.push(`\n\n${carriedEntry(range)}`);
  }
  if (omitted.length > 0) {
    parts.push(
      "\n\n(content omitted — call repo_read_file to fetch before citing:)",
    );
    for (const range of omitted) {
      parts.push(`\n${range.path} (lines ${range.startLine}-${range.endLine})`);
    }
  }
  return parts.join("");
}

/** Repo paths are compared as POSIX, regardless of host separator. */
function normalizePath(path: string): string {
  return path.split("\\").join("/");
}
