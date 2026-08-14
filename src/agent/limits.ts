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
/**
 * Maximum bytes of already-read file content carried into a later turn's
 * context (issue #25). Content beyond this is downgraded to path + line range
 * only. Carrying a full tool result per file is bounded by
 * MAX_TOOL_RESULT_BYTES (8 KiB), so this comfortably fits ~3 whole reads; the
 * number is re-measured once real-model cross-turn savings are known.
 */
export const MAX_CARRIED_CONTEXT_BYTES = 24 * 1024;

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

/** The `NNNN | ` prefix `repo_read_file` prepends to a numbered line. */
export function lineNumberPrefix(lineNumber: number): string {
  return `${String(lineNumber).padStart(4)} | `;
}

/**
 * Keep the first whole source lines of `content` that fit in `maxBytes` once
 * numbered with the `NNNN | ` prefix `repo_read_file` adds. `maxBytes` covers
 * the numbered output only (prefixes + newline joiners), so callers reserve
 * their own header/note bytes first. The per-line prefix is computed exactly
 * from `startLine`, so a line number wider than four digits is never
 * under-counted.
 *
 * A first line that alone exceeds the budget is byte-truncated (never dropped
 * whole) and is *not* counted as kept — the model saw only part of it, so it
 * must not be citable. `keptLines` is the number of whole lines shown (0 when
 * the first line is truncated), letting the caller record exactly the shown
 * range.
 */
export function fitSourceLines(
  content: string,
  maxBytes: number,
  startLine = 1,
): { content: string; keptLines: number; truncated: boolean } {
  const lines = content.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineBytes = byteLength(lineNumberPrefix(startLine + i)) + byteLength(line);

    if (i === 0) {
      if (lineBytes <= maxBytes) {
        kept.push(line);
        bytes += lineBytes;
        continue;
      }
      // The first line alone exceeds the budget: byte-truncate it and report
      // nothing as fully shown, so the model can never cite a partial line.
      const cut = truncateBytes(
        line,
        Math.max(maxBytes - byteLength(lineNumberPrefix(startLine)), 0),
      );
      return { content: cut.text, keptLines: 0, truncated: true };
    }

    // One byte for the newline joining this numbered line to the previous one.
    if (bytes + 1 + lineBytes > maxBytes) {
      return { content: kept.join("\n"), keptLines: kept.length, truncated: true };
    }
    kept.push(line);
    bytes += 1 + lineBytes;
  }
  return { content: kept.join("\n"), keptLines: kept.length, truncated: false };
}
