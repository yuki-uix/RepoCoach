import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  type Evidence,
  type EvidenceValidator,
  type ToolRegistry,
} from "../../src/agent";
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
