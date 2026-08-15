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
import { escapedByteLength, wrapUntrustedContext } from "./data-guard.js";

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

/** The fixed lead paragraph of the carried-context block. */
const CARRIED_LEAD =
  "Already-read ranges carried from earlier turns in this session. Ranges listed " +
  "with their content are already in context: cite them directly, do not re-read " +
  "them. For any other range, call repo_read_file first.";

/** The fixed header above the downgraded (content-omitted) range list. */
const OMITTED_HEADER = "(content omitted — call repo_read_file to fetch before citing:)";

/**
 * Fixed byte budget reserved for the omitted (path + range only) section. The
 * omitted list grows with every range that does not fit as carried content, so
 * it is capped at this size (entries plus an "… and N more range(s)" marker)
 * and can never push the block over the overall cap.
 */
const OMITTED_SECTION_BYTES = 2 * 1024;

/** Most downgraded ranges to list before collapsing the rest into one marker. */
const OMITTED_MAX_LISTED = 20;

/**
 * The loop wraps the carried block in UNTRUSTED_DATA markers before it reaches
 * the provider (see loop.ts), so the fixed wrapper overhead is part of the
 * carried-context budget. `kind` must match the loop's
 * `wrapUntrustedContext(…, { kind: "already_read" })` call.
 */
const CARRIED_WRAPPER_OVERHEAD_BYTES = byteLength(
  wrapUntrustedContext("", { kind: "already_read" }),
);

/**
 * The fixed bytes of the carried-context budget that are NOT carried content:
 * the lead paragraph, the data-guard wrapper, and the reserved omitted section.
 * Exposed so callers and tests can reason about the content budget precisely.
 */
export function carriedContextFixedBytes(): number {
  return byteLength(CARRIED_LEAD) + CARRIED_WRAPPER_OVERHEAD_BYTES + OMITTED_SECTION_BYTES;
}

/** The formatted carried entry for one range (matches formatCarriedBlock). */
function carriedEntry(range: CachedRange): string {
  return `${range.path} (lines ${range.startLine}-${range.endLine}):\n${range.content}`;
}

/** One downgraded range's path + line range line (content omitted). */
function omittedLine(range: CachedRange): string {
  return `\n${range.path} (lines ${range.startLine}-${range.endLine})`;
}

/**
 * Choose which cached ranges to carry in full, up to `maxBytes` of *wrapped*
 * carried context (the block plus the data-guard wrapper the loop adds). The
 * fixed deductions (lead, wrapper, reserved omitted section) are taken off the
 * top before any content is carried, so the block `formatCarriedBlock` renders
 * is guaranteed to stay within `maxBytes` once wrapped.
 *
 * Each entry is costed at its *escaped* size — the wrapper escapes markers
 * inside the path and content, so billing raw bytes would let a hostile file
 * stuffed with `<<<REPO_DATA_END>>>` inflate past the budget after escaping.
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

  const carriedBudget = maxBytes - carriedContextFixedBytes();
  const carry: CachedRange[] = [];
  const omitted: CachedRange[] = [];
  let used = 0;
  for (const range of ordered) {
    const entryBytes = escapedByteLength(carriedEntry(range));
    // Two separator bytes between carried entries (the "\n\n" in the block).
    const separator = carry.length === 0 ? 0 : 2;
    if (carriedBudget > 0 && used + separator + entryBytes <= carriedBudget) {
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
 * path + line ranges whose content was omitted. The downgraded list is capped
 * at `OMITTED_SECTION_BYTES` with an "… and N more range(s)" marker, so the
 * block never exceeds the budget even when every range is downgraded. The
 * caller wraps the result in data-guard markers (repository content must never
 * reach the system prompt).
 */
export function formatCarriedBlock(
  carry: readonly CachedRange[],
  omitted: readonly CachedRange[],
): string {
  const parts: string[] = [CARRIED_LEAD];
  for (const range of carry) {
    parts.push(`\n\n${carriedEntry(range)}`);
  }
  parts.push(formatOmittedSection(omitted));
  return parts.join("");
}

/** Render the downgraded list within the reserved omitted-section byte budget. */
function formatOmittedSection(omitted: readonly CachedRange[]): string {
  if (omitted.length === 0) {
    return "";
  }
  const header = `\n\n${OMITTED_HEADER}`;
  // Reserve the longest possible overflow marker up front (the count is at most
  // `omitted.length`, and "range(s)" keeps the suffix a constant length) so the
  // section can never exceed the budget even when the marker is what doesn't fit.
  const overflowMarker = `\n… and ${omitted.length} more range(s)`;
  const lines: string[] = [];
  let used = byteLength(header);
  let listed = 0;
  for (const range of omitted) {
    if (listed >= OMITTED_MAX_LISTED) {
      break;
    }
    const line = omittedLine(range);
    // The path is repo content, so it is escaped by the wrapper; bill its
    // escaped size so a marker-laden path cannot inflate the section over cap.
    const lineBytes = escapedByteLength(line);
    if (used + lineBytes + byteLength(overflowMarker) > OMITTED_SECTION_BYTES) {
      break;
    }
    lines.push(line);
    used += lineBytes;
    listed += 1;
  }
  const unlisted = omitted.length - listed;
  const suffix = unlisted > 0 ? `\n… and ${unlisted} more range(s)` : "";
  return `${header}${lines.join("")}${suffix}`;
}

/** The final, already-wrapped carried block and the ranges it actually carries. */
export interface BuiltCarriedBlock {
  /** The UNTRUSTED_DATA-wrapped message, guaranteed ≤ `maxBytes`. */
  content: string;
  /** The ranges whose full content landed in context — record exactly these. */
  carried: CachedRange[];
}

/**
 * Build the whole cross-turn carried-context message: select what fits (billed
 * at escaped size), format it, wrap it in UNTRUSTED_DATA markers, and enforce a
 * final hard cap on the *wrapped* bytes. The escaped accounting in
 * `selectCarryRanges` already keeps the wrapped block within `maxBytes`, so this
 * last loop is a defense-in-depth guarantee that covers any future wrapper prose
 * or a marker split across the entry separator. If the wrapped block still
 * overflows, whole entries are dropped from the tail (least valuable) and
 * downgraded to the path + line list, so the returned `carried` list is exactly
 * the content the model saw — callers must record only those, never the dropped
 * tail.
 */
export function buildCarriedBlock(
  ranges: readonly CachedRange[],
  maxBytes: number,
): BuiltCarriedBlock {
  const { carry, omitted } = selectCarryRanges(ranges, maxBytes);
  let wrapped = wrapUntrustedContext(formatCarriedBlock(carry, omitted), {
    kind: "already_read",
  });
  while (byteLength(wrapped) > maxBytes && carry.length > 0) {
    omitted.push(carry.pop()!);
    wrapped = wrapUntrustedContext(formatCarriedBlock(carry, omitted), {
      kind: "already_read",
    });
  }
  return { content: wrapped, carried: carry };
}

/** Repo paths are compared as POSIX, regardless of host separator. */
function normalizePath(path: string): string {
  return path.split("\\").join("/");
}
