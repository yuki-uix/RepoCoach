import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "../../src/evidence";
import { createReader, type Repository } from "../../src/reader";
import type { Evidence } from "../../src/domain";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");

function fixtureReader(): { reader: ReturnType<typeof createReader>; repo: Repository } {
  const reader = createReader({ cacheRoot: mkdtempSync(join(tmpdir(), "repocoach-cache-")) });
  const repo: Repository = {
    source: { kind: "local", path: fixtureRoot },
    rootDir: fixtureRoot,
    sha: "fixture",
    meta: null,
  };
  return { reader, repo };
}

/** The fixture file's lines, with a trailing empty line (from the final \n) removed. */
function fixtureLines(relPath: string): string[] {
  const raw = readFileSync(join(fixtureRoot, relPath), "utf8");
  const lines = raw.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

describe("InMemoryEvidenceStore", () => {
  it("saves evidence with session and turn association", () => {
    const store = new InMemoryEvidenceStore();
    const first: Evidence = { path: "a.ts", startLine: 1, endLine: 2, reason: "x" };
    const second: Evidence = { path: "b.ts", startLine: 3, endLine: 4, reason: "y" };

    store.save("s1", 0, first);
    store.save("s1", 1, second);
    store.save("s2", 0, first);

    expect(store.listBySession("s1")).toEqual([
      { sessionId: "s1", turnIndex: 0, evidence: first },
      { sessionId: "s1", turnIndex: 1, evidence: second },
    ]);
    expect(store.listBySession("s2")).toHaveLength(1);
    expect(store.listBySession("unknown")).toEqual([]);
  });

  it("returns source context matching the fixture's real lines, plus two lines of context", () => {
    const store = new InMemoryEvidenceStore();
    const { reader, repo } = fixtureReader();

    // call-chain.json pins validate() at src/parse/validate.ts lines 24-32.
    const evidence: Evidence = {
      path: "src/parse/validate.ts",
      startLine: 24,
      endLine: 32,
      reason: "validate",
    };
    const context = store.getSourceContext(evidence, reader, repo);

    const lines = fixtureLines("src/parse/validate.ts");
    const expectedStart = Math.max(1, evidence.startLine - 2);
    const expectedEnd = Math.min(evidence.endLine + 2, lines.length);

    expect(context.path).toBe("src/parse/validate.ts");
    expect(context.startLine).toBe(expectedStart);
    expect(context.endLine).toBe(expectedEnd);
    expect(context.totalLines).toBe(lines.length);
    expect(context.content).toBe(lines.slice(expectedStart - 1, expectedEnd).join("\n"));
  });
});
