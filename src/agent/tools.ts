/**
 * Read-only repository tools.
 *
 * Registers the five repo tools with their JSON-Schema definitions and binds
 * their executors to a Reader + Repository pair. Every executor catches Reader
 * errors and returns them as strings for the model — a failing tool never
 * aborts the loop. repo_save_evidence validates each claim through the
 * injectable EvidenceValidator (default: accept everything; issue #5 swaps in
 * constructive grounding) and appends accepted claims to the turn's list.
 *
 * Byte-cap coverage (§6 "同一道闸覆盖所有出口"): every string an executor
 * returns to the model is bounded by MAX_TOOL_RESULT_BYTES.
 *
 * - repo_get_tree   → truncateBytes over the file listing (+ note when cut)
 * - repo_search     → per-match whole-line truncation (+ note), recorder only
 *                     sees the lines actually shown
 * - repo_read_file  → fitSourceLines over the numbered content, with header and
 *                     truncation-note bytes reserved up front (+ note)
 * - repo_get_package_info → truncateBytes over the JSON summary (+ note)
 * - repo_save_evidence → truncateBytes over the receipt / rejection string
 * - the outer catch → truncateBytes over `Error: <message>`; the small
 *                     schema-error / unknown-tool strings are constant-bounded
 */

import { z } from "zod";
import { evidenceSchema, type Evidence } from "../domain/index.js";
import type { Repository, Reader, SearchMatch } from "../reader/index.js";
import { formatZodError } from "./errors.js";
import {
  MAX_TOOL_RESULT_BYTES,
  byteLength,
  fitSourceLines,
  lineNumberPrefix,
  truncateBytes,
} from "./limits.js";
import type { ToolDefinition } from "./provider.js";
import type { SessionReadCache } from "./read-cache.js";

export interface EvidenceValidator {
  validate(evidence: Evidence): { ok: true } | { ok: false; reason: string };
  /** Optional per-turn hook; the loop calls it at the start of each turn. */
  setTurnIndex?(turnIndex: number): void;
}

/** Default validator: every claim passes (constructive grounding lands in #5). */
export const acceptAllEvidence: EvidenceValidator = {
  validate() {
    return { ok: true };
  },
};

/**
 * Records the (path, line range) a tool actually returned, so the evidence
 * validator can later prove a claim was read this turn. The loop binds this to
 * the ToolReturnLedger (see src/evidence/ledger.ts).
 */
export interface ReturnRecorder {
  record(path: string, startLine: number, endLine: number): void;
  /** True when this exact (path, inclusive line range) was already returned this turn. */
  hasRead?(path: string, startLine: number, endLine: number): boolean;
  /** True when this exact range was carried into the current turn's context. */
  hasCarried?(path: string, startLine: number, endLine: number): boolean;
}

export interface ToolRuntime {
  reader: Reader;
  repo: Repository;
  evidenceValidator?: EvidenceValidator;
  returnRecorder?: ReturnRecorder;
  /** Session-level record of shown file ranges, carried across turns (issue #25). */
  readCache?: SessionReadCache;
}

export interface ToolExecution {
  name: string;
  /** Parsed arguments object (the executor re-validates the shape). */
  args: unknown;
  /** This turn's collected evidence list — repo_save_evidence appends here. */
  collectedEvidence: Evidence[];
}

export interface ToolRegistry {
  definitions: ToolDefinition[];
  execute(execution: ToolExecution): Promise<string>;
}

const searchArgsSchema = z.object({
  pattern: z.string().min(1),
  contextLines: z.number().int().nonnegative().optional(),
});

const readFileArgsSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

const repoGetTreeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "repo_get_tree",
    description:
      "List the readable source files in the repository as relative paths with sizes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const repoSearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "repo_search",
    description:
      "Search the repository source for a substring/regex and return matches with exact file paths, line numbers, and surrounding context.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Substring or regex to search for." },
        contextLines: {
          type: "integer",
          minimum: 0,
          description: "Context lines around each match (default 2).",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
};

const repoReadFileTool: ToolDefinition = {
  type: "function",
  function: {
    name: "repo_read_file",
    description:
      "Read a repository source file (optionally a line range) and return its content with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative file path." },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const repoGetPackageInfoTool: ToolDefinition = {
  type: "function",
  function: {
    name: "repo_get_package_info",
    description:
      "Return a summary of the repository's package.json (name, scripts, dependencies, workspaces). Scripts are never executed.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const repoSaveEvidenceTool: ToolDefinition = {
  type: "function",
  function: {
    name: "repo_save_evidence",
    description:
      "Record a piece of evidence (file path + line range + reason) you retrieved this turn. Only accepted when it passes validation. Before citing package.json or any file content, you must first repo_read_file that range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        reason: { type: "string" },
      },
      required: ["path", "startLine", "endLine", "reason"],
      additionalProperties: false,
    },
  },
};

/** Build the tool registry bound to a Reader + Repository pair. */
export function createToolRegistry(runtime: ToolRuntime): ToolRegistry {
  const validator = runtime.evidenceValidator ?? acceptAllEvidence;

  async function execute(execution: ToolExecution): Promise<string> {
    try {
      return await executeTool(runtime, validator, execution);
    } catch (error) {
      const message = `Error: ${error instanceof Error ? error.message : String(error)}`;
      return truncateBytes(message, MAX_TOOL_RESULT_BYTES).text;
    }
  }

  return {
    definitions: [
      repoGetTreeTool,
      repoSearchTool,
      repoReadFileTool,
      repoGetPackageInfoTool,
      repoSaveEvidenceTool,
    ],
    execute,
  };
}

function executeTool(
  runtime: ToolRuntime,
  validator: EvidenceValidator,
  execution: ToolExecution,
): string | Promise<string> {
  switch (execution.name) {
    case "repo_get_tree": {
      const entries = runtime.reader.getTree(runtime.repo);
      if (entries.length === 0) {
        return "(no readable files)";
      }
      const listing = entries.map((entry) => `${entry.path} (${entry.size} bytes)`).join("\n");
      if (byteLength(listing) <= MAX_TOOL_RESULT_BYTES) {
        return listing;
      }
      const note = `\n(结果已截断：超过 ${MAX_TOOL_RESULT_BYTES} 字节，可用 repo_search 定位具体文件)`;
      const capped = truncateBytes(listing, MAX_TOOL_RESULT_BYTES - byteLength(note));
      return `${capped.text}${note}`;
    }

    case "repo_search": {
      const parsed = searchArgsSchema.safeParse(execution.args);
      if (!parsed.success) {
        return `Error: ${formatZodError(parsed.error)}`;
      }
      return search(runtime, parsed.data);
    }

    case "repo_read_file": {
      const parsed = readFileArgsSchema.safeParse(execution.args);
      if (!parsed.success) {
        return `Error: ${formatZodError(parsed.error)}`;
      }
      return readFile(runtime, parsed.data);
    }

    case "repo_get_package_info": {
      const info = runtime.reader.getPackageInfo(runtime.repo);
      const text = JSON.stringify(info, null, 2);
      if (byteLength(text) <= MAX_TOOL_RESULT_BYTES) {
        return text;
      }
      const note = `\n(内容已截断：超过 ${MAX_TOOL_RESULT_BYTES} 字节，脚本 ${info.scripts.length} 个、依赖 ${info.dependencies.length} 个)`;
      const capped = truncateBytes(text, MAX_TOOL_RESULT_BYTES - byteLength(note));
      return `${capped.text}${note}`;
    }

    case "repo_save_evidence": {
      const parsed = evidenceSchema.safeParse(execution.args);
      if (!parsed.success) {
        return `Error: invalid evidence: ${formatZodError(parsed.error)}`;
      }
      const verdict = validator.validate(parsed.data);
      if (!verdict.ok) {
        return truncateBytes(
          `Error: evidence rejected: ${verdict.reason}`,
          MAX_TOOL_RESULT_BYTES,
        ).text;
      }
      execution.collectedEvidence.push(parsed.data);
      const evidence = parsed.data;
      return truncateBytes(
        `Saved evidence: ${evidence.path} lines ${evidence.startLine}-${evidence.endLine} (${evidence.reason})`,
        MAX_TOOL_RESULT_BYTES,
      ).text;
    }

    default:
      return `Error: unknown tool: ${execution.name}`;
  }
}

async function search(
  runtime: ToolRuntime,
  args: { pattern: string; contextLines?: number },
): Promise<string> {
  const matches = await runtime.reader.search(
    runtime.repo,
    args.pattern,
    args.contextLines === undefined ? undefined : { contextLines: args.contextLines },
  );
  if (matches.length === 0) {
    return "No matches found.";
  }
  // Build the result within the byte budget, recording only the lines actually
  // shown so grounding never covers a match (or context line) the model did not
  // see. The note that signals truncation consumes bytes too, so it is reserved
  // up front — every match (including the first) is cut to whole display lines.
  const note = "\n\n(结果已截断：更多匹配未显示，可用更窄的 pattern 或更小的 contextLines 重搜)";
  const contentBudget = MAX_TOOL_RESULT_BYTES - byteLength(note);
  const parts: string[] = [];
  let usedBytes = 0;

  for (const match of matches) {
    const sep = parts.length === 0 ? "" : "\n\n";
    const sepBytes = byteLength(sep);
    const wholeText = formatSearchMatch(match);

    if (usedBytes + sepBytes + byteLength(wholeText) <= contentBudget) {
      parts.push(sep + wholeText);
      usedBytes += sepBytes + byteLength(wholeText);
      runtime.returnRecorder?.record(
        match.path,
        match.line - match.contextBefore.length,
        match.line + match.contextAfter.length,
      );
      continue;
    }

    // This match does not fit in full: truncate it to whole lines and stop,
    // recording only the source lines that are fully shown.
    const budget = contentBudget - usedBytes - sepBytes;
    const fit = truncateMatchLines(searchMatchLines(match), Math.max(budget, 0));
    if (fit.text !== "") {
      parts.push(sep + fit.text);
      if (fit.range !== null) {
        runtime.returnRecorder?.record(match.path, fit.range.startLine, fit.range.endLine);
      }
    }
    return `${parts.join("")}${note}`;
  }
  return parts.join("");
}

/** One display line of a search match, tagged with the source line it shows. */
interface SearchDisplayLine {
  sourceLine: number;
  text: string;
}

/**
 * The display lines of a match in output order: the `path:line:col:` header
 * first (so the match itself is protected from truncation), then the context
 * lines. Each line carries its 1-based source line for honest range recording.
 */
function searchMatchLines(match: SearchMatch): SearchDisplayLine[] {
  const lines: SearchDisplayLine[] = [
    {
      sourceLine: match.line,
      text: `${match.path}:${match.line}:${match.column}: ${match.matchText}`,
    },
  ];
  match.contextBefore.forEach((text, index) => {
    lines.push({
      sourceLine: match.line - match.contextBefore.length + index,
      text: `  - ${text}`,
    });
  });
  match.contextAfter.forEach((text, index) => {
    lines.push({
      sourceLine: match.line + 1 + index,
      text: `  + ${text}`,
    });
  });
  return lines;
}

function formatSearchMatch(match: SearchMatch): string {
  return searchMatchLines(match)
    .map((line) => line.text)
    .join("\n");
}

/**
 * Keep the first whole display lines of a match that fit in `maxBytes`, so a
 * single match can never blow the per-result cap. The source range covered by
 * the fully-shown lines is returned for recording; when the very first line
 * (the match header) alone exceeds the budget it is byte-truncated and nothing
 * is citable (`range: null`), because the model saw only part of that line.
 */
function truncateMatchLines(
  lines: SearchDisplayLine[],
  maxBytes: number,
): { text: string; range: { startLine: number; endLine: number } | null } {
  const first = lines[0]!;
  if (byteLength(first.text) > maxBytes) {
    return { text: truncateBytes(first.text, maxBytes).text, range: null };
  }
  const kept: SearchDisplayLine[] = [first];
  let bytes = byteLength(first.text);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (bytes + 1 + byteLength(line.text) > maxBytes) {
      break;
    }
    kept.push(line);
    bytes += 1 + byteLength(line.text);
  }
  const startLine = Math.min(...kept.map((line) => line.sourceLine));
  const endLine = Math.max(...kept.map((line) => line.sourceLine));
  return {
    text: kept.map((line) => line.text).join("\n"),
    range: { startLine, endLine },
  };
}

function readFile(
  runtime: ToolRuntime,
  args: { path: string; startLine?: number; endLine?: number },
): string {
  const slice = runtime.reader.readFile(
    runtime.repo,
    args.path,
    args.startLine,
    args.endLine,
  );
  // The range is already carried into this turn's context (cross-turn cache):
  // point at it instead of re-sending the full text (issue #25, token waste).
  if (runtime.returnRecorder?.hasCarried?.(args.path, slice.startLine, slice.endLine)) {
    return `${args.path} (lines ${slice.startLine}-${slice.endLine}) 本轮上下文中已携带，见上文，无需重读。`;
  }
  // Same-turn re-read of the exact range: point at the earlier result instead
  // of re-sending the full text (issue #23, token waste).
  if (runtime.returnRecorder?.hasRead?.(args.path, slice.startLine, slice.endLine)) {
    return `${args.path} (lines ${slice.startLine}-${slice.endLine}) 本轮已读，见上文。`;
  }
  const header = `${args.path} (lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines})`;
  if (slice.content === "") {
    // Record the empty slice so a claim for this range is never grounded.
    runtime.returnRecorder?.record(args.path, slice.startLine, slice.endLine);
    return `${header}\n(empty)`;
  }
  // Reserve the header, the newline, and the truncation note up front, then fit
  // the *numbered* lines into what remains. The note covers both the normal
  // "more lines follow" case and the "first line alone blew the cap" case, so
  // the longer one is reserved and the final string can never exceed the cap.
  const noteTruncated = `\n(内容已截断：超过 ${MAX_TOOL_RESULT_BYTES} 字节，可用更小的行号范围重读剩余部分)`;
  const noteUncitable = `\n(内容已截断：首行即超过 ${MAX_TOOL_RESULT_BYTES} 字节，未完整显示任何一行，此行不可引用)`;
  const reservedBytes =
    byteLength(header) +
    byteLength("\n") +
    Math.max(byteLength(noteTruncated), byteLength(noteUncitable));
  const fit = fitSourceLines(
    slice.content,
    MAX_TOOL_RESULT_BYTES - reservedBytes,
    slice.startLine,
  );
  const numbered = numberLines(fit.content, slice.startLine);
  // Record only whole lines actually shown — a byte-truncated first line (or a
  // truncated tail) must not be citable. The session read cache mirrors the
  // same shown range, so only exactly what the model saw can be carried later.
  if (fit.keptLines > 0) {
    const endLine = slice.startLine + fit.keptLines - 1;
    runtime.returnRecorder?.record(args.path, slice.startLine, endLine);
    runtime.readCache?.record(args.path, slice.startLine, endLine, numbered);
  }
  if (!fit.truncated) {
    return `${header}\n${numbered}`;
  }
  const note = fit.keptLines === 0 ? noteUncitable : noteTruncated;
  return `${header}\n${numbered}${note}`;
}

function numberLines(content: string, startLine: number): string {
  if (content === "") {
    return "";
  }
  return content
    .split("\n")
    .map((line, index) => `${lineNumberPrefix(startLine + index)}${line}`)
    .join("\n");
}
