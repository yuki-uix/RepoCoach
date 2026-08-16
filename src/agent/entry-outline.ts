/**
 * First-turn entry structure outline (issue #29).
 *
 * A deep library (Zod, Hono) makes the model run many exploratory searches to
 * locate symbols, even though the candidate already lists its entry files. This
 * builder turns those entry files into a compact structural map — top-level
 * exported symbol names plus their line numbers, with NO implementation
 * content — and the loop injects it into the first turn's context.
 *
 * It reuses the candidate generator's barrel penetration
 * (`resolveExportedSymbols`, PR #30) so the outline is built from the exact
 * symbols the candidates were grounded on: a barrel entry is followed to the
 * files that actually define its exports, and each symbol carries the line of
 * its `export` keyword.
 *
 * Data-guard discipline: the block is wrapped in UNTRUSTED_DATA markers (file
 * paths are repo content and could carry a forged marker) and hard-capped at
 * `MAX_ENTRY_OUTLINE_BYTES` before it ever reaches the loop. Because it carries
 * only names and line numbers — never implementation — the loop must NOT record
 * these ranges into the tool-return ledger; a symbol name is not evidence the
 * model has read anything.
 */

import type { Reader, Repository } from "../reader/index.js";
import {
  resolveExportedSymbols,
  type ResolvedSymbol,
} from "../candidates/heuristic.js";
import { escapedByteLength, wrapUntrustedContext } from "./data-guard.js";
import { MAX_ENTRY_OUTLINE_BYTES, byteLength } from "./limits.js";

export interface EntryOutline {
  /** The UNTRUSTED_DATA-wrapped block, guaranteed ≤ MAX_ENTRY_OUTLINE_BYTES. */
  content: string;
  /** `byteLength(content)` — reported as the `entryOutlineBytes` metric. */
  bytes: number;
  /** Number of distinct defining files actually included in the block. */
  fileCount: number;
}

/** Fixed lead paragraph telling the model what the outline is (and is not). */
const OUTLINE_LEAD =
  "Entry structure outline (top-level exported symbols only — names and line " +
  "numbers, not implementation). Read a symbol's file range with repo_read_file " +
  "before citing it as evidence.";

const OUTLINE_WRAPPER_OVERHEAD = byteLength(
  wrapUntrustedContext("", { kind: "entry_outline" }),
);

export async function buildEntryOutline(
  reader: Reader,
  repo: Repository,
  entryFiles: readonly string[],
): Promise<EntryOutline | null> {
  if (entryFiles.length === 0) {
    return null;
  }
  const treePaths = new Set(reader.getTree(repo).map((entry) => entry.path));
  const resolved = await resolveExportedSymbols(reader, repo, [...entryFiles], treePaths);
  if (resolved.length === 0) {
    return null;
  }

  // Group by defining file, preserving first-appearance order so the candidate's
  // declared order wins and the model sees the entry surface in that order.
  const order: string[] = [];
  const byFile = new Map<string, ResolvedSymbol[]>();
  for (const symbol of resolved) {
    const group = byFile.get(symbol.file);
    if (group === undefined) {
      byFile.set(symbol.file, [symbol]);
      order.push(symbol.file);
    } else {
      group.push(symbol);
    }
  }

  // Reserve the fixed deductions up front — wrapper, lead, and the longest
  // possible omission note — then fit whole files into what remains.
  const maxNoteBytes = byteLength(`\n\n… ${order.length} more entry file(s) omitted`);
  const contentBudget =
    MAX_ENTRY_OUTLINE_BYTES - OUTLINE_WRAPPER_OVERHEAD - byteLength(OUTLINE_LEAD) - maxNoteBytes;

  let included = 0;
  let used = 0;
  for (const file of order) {
    const block = formatFileBlock(file, byFile.get(file)!);
    const separator = included === 0 ? 0 : 2;
    if (contentBudget <= 0 || used + separator + escapedByteLength(block) > contentBudget) {
      break;
    }
    included += 1;
    used += separator + escapedByteLength(block);
  }

  let wrapped = renderOutline(order, byFile, included);
  // Defense-in-depth hard cap (mirrors buildCarriedBlock): if the wrapped block
  // still overflows (future prose or a marker split across a separator), drop
  // whole files from the tail until it fits.
  while (byteLength(wrapped) > MAX_ENTRY_OUTLINE_BYTES && included > 0) {
    included -= 1;
    wrapped = renderOutline(order, byFile, included);
  }

  return { content: wrapped, bytes: byteLength(wrapped), fileCount: included };
}

/** One defining file's block: the path plus one `name (kind, line N)` per symbol. */
function formatFileBlock(file: string, symbols: ResolvedSymbol[]): string {
  const lines = symbols.map(
    (symbol) => `  ${symbol.symbol.name} (${symbol.symbol.kind}, line ${symbol.symbol.line})`,
  );
  return `${file}:\n${lines.join("\n")}`;
}

/** Render the lead + the first `included` file blocks + an omission note. */
function renderOutline(
  order: readonly string[],
  byFile: ReadonlyMap<string, ResolvedSymbol[]>,
  included: number,
): string {
  const parts: string[] = [OUTLINE_LEAD];
  for (const file of order.slice(0, included)) {
    parts.push(formatFileBlock(file, byFile.get(file)!));
  }
  const omitted = order.length - included;
  if (omitted > 0) {
    parts.push(`… ${omitted} more entry file(s) omitted`);
  }
  return wrapUntrustedContext(parts.join("\n\n"), { kind: "entry_outline" });
}
