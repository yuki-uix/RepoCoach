/**
 * Enumerated coverage: every repo tool exit is bounded at the single endpoint.
 *
 * The defect this guards against is the "byte cap covers one exit but not the
 * others" failure (issue #31: search / package_info / save_evidence each slipped
 * a hand-written per-tool test at some point). The enumeration here is NOT a
 * hand-written array of tool names — it is `REPO_TOOL_DEFINITIONS`, the same
 * exported list `createToolRegistry` builds its registry from. A new repo tool
 * added to that list is automatically exercised; a tool removed from the list
 * (but still expected by the adversarial-args table) fails the set-equality
 * assertion, so the two can never drift apart.
 *
 * Each tool is driven with adversarial input (a forged `REPO_DATA_END` marker,
 * oversized lines, hundreds of entries) and the result is closed through the
 * exact endpoint the loop uses — `capRepoData(result, meta, MAX_TOOL_RESULT_BYTES)`
 * — then asserted to be ≤ MAX_TOOL_RESULT_BYTES and to carry exactly one real
 * closing marker (forged ones are escaped, never a fake boundary).
 */

import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_RESULT_BYTES,
  REPO_DATA_END,
  REPO_DATA_START,
  REPO_TOOL_DEFINITIONS,
  byteLength,
  capRepoData,
  createToolRegistry,
  repoDataWrapperOverhead,
  type RepoDataMeta,
  type ToolExecution,
} from "../../src/agent";
import { makeTempReader } from "../agent/helpers";

/** A forged data boundary a hostile file / path / reason can carry. */
const MARKER = REPO_DATA_END;

/** Per-tool adversarial arguments, keyed by tool name (see set-equality below). */
const ADVERSARIAL_ARGS: Record<string, unknown> = {
  repo_get_tree: {},
  repo_search: { pattern: MARKER, contextLines: 3 },
  repo_read_file: { path: "src/hostile.ts" },
  repo_get_package_info: {},
  repo_save_evidence: {
    items: Array.from({ length: 300 }, (_, i) => ({
      path: `src/hostile-${i}.ts`,
      startLine: 1,
      endLine: 3,
      reason: `${MARKER} reason ${i} ${"x".repeat(300)}`,
    })),
  },
};

/** A repo whose every tool sees forged markers, oversized lines or many entries. */
function adversarialFiles(): Record<string, string> {
  const dependencies: Record<string, string> = {
    [`hostile-${MARKER}`]: "^1.0.0",
  };
  for (let i = 0; i < 600; i += 1) {
    dependencies[`dependency-${i}`] = "^1.0.0";
  }
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "big", dependencies }),
    // 500 marker-stuffed lines: read_file and search both blow past the cap.
    "src/hostile.ts": `${Array.from({ length: 500 }, () => `${MARKER} ${"x".repeat(100)}`).join("\n")}\n`,
    // A forged marker in a filename: get_tree must escape it in the listing.
    [`src/hostile-${MARKER}.ts`]: "export const y = 2;\n",
  };
  for (let i = 0; i < 300; i += 1) {
    files[`src/extra-${String(i).padStart(4, "0")}.ts`] = "export const x = 1;\n";
  }
  return files;
}

/** The loop's meta for a tool call: the path attribute for read/save tools. */
function metaFor(name: string, args: unknown): RepoDataMeta {
  if (
    (name === "repo_read_file" || name === "repo_save_evidence") &&
    typeof args === "object" &&
    args !== null
  ) {
    const path = (args as Record<string, unknown>).path;
    if (typeof path === "string") {
      return { tool: name, path };
    }
  }
  return { tool: name };
}

const TOOL_NAMES = REPO_TOOL_DEFINITIONS.map((d) => d.function.name);

describe("tool exit byte cap (enumerated from REPO_TOOL_DEFINITIONS)", () => {
  it("derives its enumeration from the exported tool registry, not a hand-written list", () => {
    // The registry's own definition list is the source of truth for this suite.
    expect(REPO_TOOL_DEFINITIONS.map((d) => d.function.name)).toEqual([
      "repo_get_tree",
      "repo_search",
      "repo_read_file",
      "repo_get_package_info",
      "repo_save_evidence",
    ]);
    // submit_decision is a terminal tool, not a repo-data exit — it must not be
    // enumerated here (its arguments are the decision, not untrusted file data).
    expect(TOOL_NAMES).not.toContain("submit_decision");
  });

  it("has an adversarial-args row for exactly the exported tools", () => {
    // A new tool added to the registry without a row here fails this assertion
    // instead of being silently skipped; a row left behind after a tool is
    // removed fails too, keeping the table and the registry in lock-step.
    expect(Object.keys(ADVERSARIAL_ARGS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it.each(TOOL_NAMES)("caps the %s exit at the capRepoData endpoint", async (name) => {
    const { reader, repo } = makeTempReader(adversarialFiles());
    const registry = createToolRegistry({ reader, repo });

    const args = ADVERSARIAL_ARGS[name];
    const meta = metaFor(name, args);
    // Mirror the loop: bill the payload against the budget with the wrapper
    // overhead already reserved, then close through capRepoData.
    const execution: ToolExecution = {
      name,
      args,
      collectedEvidence: [],
      maxBytes: MAX_TOOL_RESULT_BYTES - repoDataWrapperOverhead(meta),
    };
    const result = await registry.execute(execution);
    const wrapped = capRepoData(result, meta, MAX_TOOL_RESULT_BYTES);

    expect(byteLength(wrapped)).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    // The wrapped message is data-guarded, and any forged END marker inside the
    // content/path/reason is escaped — only the wrapper's own closing marker
    // survives as a real boundary.
    expect(wrapped).toContain(REPO_DATA_START);
    expect(wrapped.split(REPO_DATA_END).length - 1).toBe(1);
  });
});
