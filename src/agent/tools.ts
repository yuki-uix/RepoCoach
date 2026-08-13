/**
 * Read-only repository tools.
 *
 * Registers the five repo tools with their JSON-Schema definitions and binds
 * their executors to a Reader + Repository pair. Every executor catches Reader
 * errors and returns them as strings for the model — a failing tool never
 * aborts the loop. repo_save_evidence validates each claim through the
 * injectable EvidenceValidator (default: accept everything; issue #5 swaps in
 * constructive grounding) and appends accepted claims to the turn's list.
 */

import { z } from "zod";
import { evidenceSchema, type Evidence } from "../domain/index.js";
import type { Repository, Reader } from "../reader/index.js";
import { formatZodError } from "./errors.js";
import type { ToolDefinition } from "./provider.js";

export interface EvidenceValidator {
  validate(evidence: Evidence): { ok: true } | { ok: false; reason: string };
}

/** Default validator: every claim passes (constructive grounding lands in #5). */
export const acceptAllEvidence: EvidenceValidator = {
  validate() {
    return { ok: true };
  },
};

export interface ToolRuntime {
  reader: Reader;
  repo: Repository;
  evidenceValidator?: EvidenceValidator;
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
      "Record a piece of evidence (file path + line range + reason) you retrieved this turn. Only accepted when it passes validation.",
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
      return executeTool(runtime, validator, execution);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
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
      return entries.map((entry) => `${entry.path} (${entry.size} bytes)`).join("\n");
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
      return JSON.stringify(info, null, 2);
    }

    case "repo_save_evidence": {
      const parsed = evidenceSchema.safeParse(execution.args);
      if (!parsed.success) {
        return `Error: invalid evidence: ${formatZodError(parsed.error)}`;
      }
      const verdict = validator.validate(parsed.data);
      if (!verdict.ok) {
        return `Error: evidence rejected: ${verdict.reason}`;
      }
      execution.collectedEvidence.push(parsed.data);
      const evidence = parsed.data;
      return `Saved evidence: ${evidence.path} lines ${evidence.startLine}-${evidence.endLine} (${evidence.reason})`;
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
  return matches.map(formatSearchMatch).join("\n\n");
}

function formatSearchMatch(match: {
  path: string;
  line: number;
  column: number;
  matchText: string;
  contextBefore: string[];
  contextAfter: string[];
}): string {
  const lines = [`${match.path}:${match.line}:${match.column}: ${match.matchText}`];
  for (const before of match.contextBefore) {
    lines.push(`  - ${before}`);
  }
  for (const after of match.contextAfter) {
    lines.push(`  + ${after}`);
  }
  return lines.join("\n");
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
  const header = `${args.path} (lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines})`;
  if (slice.content === "") {
    return `${header}\n(empty)`;
  }
  return `${header}\n${numberLines(slice.content, slice.startLine)}`;
}

function numberLines(content: string, startLine: number): string {
  return content
    .split("\n")
    .map((line, index) => `${String(startLine + index).padStart(4)} | ${line}`)
    .join("\n");
}
