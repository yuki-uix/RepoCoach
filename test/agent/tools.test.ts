import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_RESULT_BYTES,
  byteLength,
  createToolRegistry,
  type Evidence,
  type EvidenceValidator,
  type ReturnRecorder,
  type ToolRegistry,
} from "../../src/agent";
import { ToolReturnLedger } from "../../src/evidence";
import { makeTempReader } from "./helpers";
import type { Reader } from "../../src/reader";

const FILES = {
  "package.json": JSON.stringify({
    name: "demo",
    scripts: { test: "vitest" },
    dependencies: { zod: "^4" },
  }),
  "src/index.ts":
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "src/util.ts": "export const x = 1;\n",
};

function makeRegistry(
  evidenceValidator?: EvidenceValidator,
): { registry: ToolRegistry; collected: Evidence[] } {
  const { reader, repo } = makeTempReader(FILES);
  const collected: Evidence[] = [];
  const registry = createToolRegistry({ reader, repo, evidenceValidator });
  return { registry, collected };
}

interface RecordedRange {
  path: string;
  startLine: number;
  endLine: number;
}

function makeRecordingRecorder(): {
  recorder: ReturnRecorder;
  records: RecordedRange[];
} {
  const records: RecordedRange[] = [];
  return {
    records,
    recorder: {
      record(path, startLine, endLine) {
        records.push({ path, startLine, endLine });
      },
    },
  };
}

function makeRegistryWithRecorder(recorder: ReturnRecorder): {
  registry: ToolRegistry;
  collected: Evidence[];
} {
  const { reader, repo } = makeTempReader(FILES);
  const collected: Evidence[] = [];
  const registry = createToolRegistry({ reader, repo, returnRecorder: recorder });
  return { registry, collected };
}

describe("tool registry", () => {
  it("registers the five read-only tools", () => {
    const { registry } = makeRegistry();
    expect(registry.definitions.map((d) => d.function.name)).toEqual([
      "repo_get_tree",
      "repo_search",
      "repo_read_file",
      "repo_get_package_info",
      "repo_save_evidence",
    ]);
  });

  it("returns an error string for an unknown tool", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute({
      name: "nope",
      args: {},
      collectedEvidence: [],
    });
    expect(result).toBe("Error: unknown tool: nope");
  });

});

describe("repo_get_tree", () => {
  it("lists readable files with sizes", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute({
      name: "repo_get_tree",
      args: {},
      collectedEvidence: [],
    });
    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/util.ts");
    expect(result).toContain("package.json");
  });
});

describe("repo_read_file", () => {
  it("returns numbered content for a requested line range", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute({
      name: "repo_read_file",
      args: { path: "src/index.ts", startLine: 2, endLine: 2 },
      collectedEvidence: [],
    });
    expect(result).toContain("src/index.ts (lines 2-2 of 3)");
    expect(result).toContain("2 |   return a + b;");
  });

  it("downgrades a Reader error to a string without throwing", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute({
      name: "repo_read_file",
      args: { path: "../escape.ts" },
      collectedEvidence: [],
    });
    expect(result).toContain("Error:");
    expect(result).toContain("escapes repository root");
  });
});

describe("repo_search", () => {
  it("returns matches with paths and line numbers", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute({
      name: "repo_search",
      args: { pattern: "return" },
      collectedEvidence: [],
    });
    expect(result).toContain("src/index.ts:2:3: return");
  });

  it("downgrades an async Reader rejection to an error string", async () => {
    const { reader, repo } = makeTempReader(FILES);
    const throwingReader: Reader = {
      ...reader,
      search: () => Promise.reject(new Error("reader exploded")),
    };
    const registry = createToolRegistry({ reader: throwingReader, repo });
    const result = await registry.execute({
      name: "repo_search",
      args: { pattern: "anything" },
      collectedEvidence: [],
    });
    expect(result).toMatch(/^Error: /);
    expect(result).toContain("reader exploded");
  });
});

describe("repo_get_package_info", () => {
  it("returns a JSON summary", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute({
      name: "repo_get_package_info",
      args: {},
      collectedEvidence: [],
    });
    const parsed = JSON.parse(result) as {
      name?: string;
      scripts: string[];
      dependencies: string[];
    };
    expect(parsed.name).toBe("demo");
    expect(parsed.scripts).toContain("test");
    expect(parsed.dependencies).toContain("zod");
  });
});

describe("repo_save_evidence", () => {
  it("appends accepted evidence to the turn's list", async () => {
    const { registry, collected } = makeRegistry();
    const result = await registry.execute({
      name: "repo_save_evidence",
      args: { path: "src/index.ts", startLine: 1, endLine: 3, reason: "entry" },
      collectedEvidence: collected,
    });
    expect(result).toContain("Saved evidence");
    expect(collected).toEqual([
      { path: "src/index.ts", startLine: 1, endLine: 3, reason: "entry" },
    ]);
  });

  it("reports a rejected claim and does not append it", async () => {
    const rejecting: EvidenceValidator = {
      validate: () => ({ ok: false, reason: "not grounded" }),
    };
    const { registry, collected } = makeRegistry(rejecting);
    const result = await registry.execute({
      name: "repo_save_evidence",
      args: { path: "src/index.ts", startLine: 1, endLine: 3, reason: "entry" },
      collectedEvidence: collected,
    });
    expect(result).toContain("Error: evidence rejected: not grounded");
    expect(collected).toHaveLength(0);
  });

  it("rejects malformed arguments", async () => {
    const { registry, collected } = makeRegistry();
    const result = await registry.execute({
      name: "repo_save_evidence",
      args: { path: "src/index.ts" },
      collectedEvidence: collected,
    });
    expect(result).toContain("Error: invalid evidence");
    expect(collected).toHaveLength(0);
  });
});

describe("return recording", () => {
  it("records the actual returned slice range, not the requested range", async () => {
    const { recorder, records } = makeRecordingRecorder();
    const { registry } = makeRegistryWithRecorder(recorder);

    await registry.execute({
      name: "repo_read_file",
      args: { path: "src/index.ts", startLine: 1, endLine: 99 },
      collectedEvidence: [],
    });

    // src/index.ts has 3 lines; the request for 1-99 is clamped to 1-3.
    expect(records).toEqual([{ path: "src/index.ts", startLine: 1, endLine: 3 }]);
  });

  it("records each search match line plus its context lines", async () => {
    const { recorder, records } = makeRecordingRecorder();
    const { registry } = makeRegistryWithRecorder(recorder);

    // "return" matches src/index.ts line 2; default context is 2 lines,
    // so the actual returned range is line 1 through line 3.
    await registry.execute({
      name: "repo_search",
      args: { pattern: "return" },
      collectedEvidence: [],
    });

    expect(records).toContainEqual({ path: "src/index.ts", startLine: 1, endLine: 3 });
  });

  it("records only the match line when no context is requested", async () => {
    const { recorder, records } = makeRecordingRecorder();
    const { registry } = makeRegistryWithRecorder(recorder);

    await registry.execute({
      name: "repo_search",
      args: { pattern: "return", contextLines: 0 },
      collectedEvidence: [],
    });

    expect(records).toContainEqual({ path: "src/index.ts", startLine: 2, endLine: 2 });
  });

  it("does not record tree or package-info results", async () => {
    const { recorder, records } = makeRecordingRecorder();
    const { registry } = makeRegistryWithRecorder(recorder);

    await registry.execute({ name: "repo_get_tree", args: {}, collectedEvidence: [] });
    await registry.execute({
      name: "repo_get_package_info",
      args: {},
      collectedEvidence: [],
    });

    expect(records).toHaveLength(0);
  });
});

describe("same-turn read dedup", () => {
  it("returns a short hint instead of re-sending an already-read range", async () => {
    const { reader, repo } = makeTempReader(FILES);
    const ledger = new ToolReturnLedger();
    const registry = createToolRegistry({ reader, repo, returnRecorder: ledger });

    await registry.execute({
      name: "repo_read_file",
      args: { path: "src/index.ts", startLine: 1, endLine: 3 },
      collectedEvidence: [],
    });
    const second = await registry.execute({
      name: "repo_read_file",
      args: { path: "src/index.ts", startLine: 1, endLine: 3 },
      collectedEvidence: [],
    });

    expect(second).toContain("本轮已读");
    expect(second).not.toContain("return a + b");
  });

  it("does not dedup a different range of the same file", async () => {
    const { reader, repo } = makeTempReader(FILES);
    const ledger = new ToolReturnLedger();
    const registry = createToolRegistry({ reader, repo, returnRecorder: ledger });

    await registry.execute({
      name: "repo_read_file",
      args: { path: "src/index.ts", startLine: 1, endLine: 1 },
      collectedEvidence: [],
    });
    const second = await registry.execute({
      name: "repo_read_file",
      args: { path: "src/index.ts", startLine: 2, endLine: 2 },
      collectedEvidence: [],
    });

    expect(second).toContain("2 |   return a + b;");
  });
});

describe("repo_read_file truncation", () => {
  it("truncates a large read and records only the shown range", async () => {
    const bigLine = "const x = 1;\n";
    const manyLines = bigLine.repeat(5_000);
    const { reader, repo } = makeTempReader({ "src/big.ts": manyLines });
    const ledger = new ToolReturnLedger();
    const registry = createToolRegistry({ reader, repo, returnRecorder: ledger });

    const result = await registry.execute({
      name: "repo_read_file",
      args: { path: "src/big.ts" },
      collectedEvidence: [],
    });

    expect(result).toContain("内容已截断");
    // The recorded range stops where the truncation cut the content, so a
    // claim spanning the whole (unshown) file is not grounded.
    expect(ledger.isGrounded({ path: "src/big.ts", startLine: 1, endLine: 5_000, reason: "" })).toBe(false);
  });
});

describe("repo_search truncation", () => {
  it("caps the first oversized match and does not ground truncated context lines", async () => {
    // A match on the first line with a huge context pulls in ~300 lines, so the
    // very first match already exceeds the per-result cap.
    const lines = Array.from({ length: 300 }, (_, i) =>
      i === 0 ? `NEEDLE ${"x".repeat(60)}` : `line ${i} ${"x".repeat(60)}`,
    );
    const { reader, repo } = makeTempReader({ "src/big.ts": lines.join("\n") + "\n" });
    const ledger = new ToolReturnLedger();
    const registry = createToolRegistry({ reader, repo, returnRecorder: ledger });

    const result = await registry.execute({
      name: "repo_search",
      args: { pattern: "NEEDLE", contextLines: 300 },
      collectedEvidence: [],
    });

    expect(byteLength(result)).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect(result).toContain("结果已截断");
    // The match line itself is shown and citable.
    expect(
      ledger.isGrounded({ path: "src/big.ts", startLine: 1, endLine: 1, reason: "" }),
    ).toBe(true);
    // A context line past the truncation point was never returned, so citing it
    // is not grounded.
    expect(
      ledger.isGrounded({ path: "src/big.ts", startLine: 300, endLine: 300, reason: "" }),
    ).toBe(false);
  });

  it("drops a single oversized context line without recording it", async () => {
    const { reader, repo } = makeTempReader({
      "src/big.ts": "NEEDLE short\n" + "x".repeat(20_000) + "\n",
    });
    const ledger = new ToolReturnLedger();
    const registry = createToolRegistry({ reader, repo, returnRecorder: ledger });

    const result = await registry.execute({
      name: "repo_search",
      args: { pattern: "NEEDLE", contextLines: 1 },
      collectedEvidence: [],
    });

    expect(byteLength(result)).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect(result).toContain("结果已截断");
    // The oversized context line (line 2) is dropped whole, so it is not citable.
    expect(
      ledger.isGrounded({ path: "src/big.ts", startLine: 2, endLine: 2, reason: "" }),
    ).toBe(false);
  });

  it("byte-caps a single oversized match line and leaves it uncitable", async () => {
    // A single source line that is itself a giant match makes the header line
    // alone exceed the cap; it is byte-truncated and not recorded.
    const { reader, repo } = makeTempReader({ "src/big.ts": "x".repeat(20_000) + "\n" });
    const ledger = new ToolReturnLedger();
    const registry = createToolRegistry({ reader, repo, returnRecorder: ledger });

    const result = await registry.execute({
      name: "repo_search",
      args: { pattern: "x+", contextLines: 0 },
      collectedEvidence: [],
    });

    expect(byteLength(result)).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect(result).toContain("结果已截断");
    // Only part of the match line is visible, so citing it is not grounded.
    expect(
      ledger.isGrounded({ path: "src/big.ts", startLine: 1, endLine: 1, reason: "" }),
    ).toBe(false);
  });
});

describe("repo_get_package_info truncation", () => {
  it("caps a package.json with hundreds of dependencies and adds a note", async () => {
    const dependencies: Record<string, string> = {};
    for (let i = 0; i < 600; i++) {
      dependencies[`dependency-${i}`] = "^1.0.0";
    }
    const { reader, repo } = makeTempReader({
      "package.json": JSON.stringify({ name: "big", dependencies }),
    });
    const registry = createToolRegistry({ reader, repo });

    const result = await registry.execute({
      name: "repo_get_package_info",
      args: {},
      collectedEvidence: [],
    });

    expect(byteLength(result)).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect(result).toContain("内容已截断");
  });
});
