/**
 * Context-size limits and helpers for the agent loop.
 *
 * The real-model smoke run blew the token budget on repeated reads and long
 * tool results, so the loop bounds what it sends the model: a per-tool result
 * cap, and a cap on the turn-history summary. The dedup of same-turn re-reads
 * lives in the tools layer (see tools.ts) because it must consult the
 * ToolReturnLedger. Budget *constants* are deliberately not changed here — the
 * numbers are re-measured once trimming lands (issue #23).
 */

/** Maximum bytes of a single tool result before it is truncated. */
export const MAX_TOOL_RESULT_BYTES = 8 * 1024;
/** Maximum bytes of the summarized turn history before older turns collapse. */
export const MAX_HISTORY_SUMMARY_BYTES = 4 * 1024;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Byte-truncate arbitrary text without splitting a multi-byte character. */
export function truncateBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  let slice = "";
  for (const ch of text) {
    if (byteLength(slice + ch) > maxBytes) {
      break;
    }
    slice += ch;
  }
  return { text: slice, truncated: true };
}

/**
 * Keep the first whole source lines of `content` that fit in `maxBytes`,
 * accounting for the `NNNN | ` line-numbering prefix `repo_read_file` adds.
 * At least one line is always kept, so a single oversized line is never
 * dropped entirely. Returns the kept content and how many source lines it
 * spans, so the caller can record the *shown* range (grounding honesty).
 */
export function fitSourceLines(
  content: string,
  maxBytes: number,
): { content: string; keptLines: number; truncated: boolean } {
  const lines = content.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // "NNNN | " prefix + trailing newline, roughly 8 bytes per line.
    const lineBytes = byteLength(line) + 8;
    if (i > 0 && bytes + lineBytes > maxBytes) {
      return { content: kept.join("\n"), keptLines: kept.length, truncated: true };
    }
    kept.push(line);
    bytes += lineBytes;
  }
  return { content: kept.join("\n"), keptLines: kept.length, truncated: false };
}
