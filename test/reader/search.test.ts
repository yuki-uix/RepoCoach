import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSlice } from "../../src/reader/read-file";
import { searchRepo } from "../../src/reader/search";
import { writeFiles } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-search-"));
  tempDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

const APP_TS = "import x from 'x';\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n";

describe("searchRepo", () => {
  it("reports the correct 1-based line, column and match text", async () => {
    const root = makeRoot({ "src/app.ts": APP_TS });
    const results = await searchRepo(root, "return", { contextLines: 1 });

    expect(results).toHaveLength(1);
    const hit = results[0];
    expect(hit.path).toBe("src/app.ts");
    expect(hit.line).toBe(4);
    expect(hit.column).toBe(3);
    expect(hit.matchText).toBe("return");

    // Cross-check against the actual file content at that line.
    const slice = readFileSlice(root, "src/app.ts", hit.line, hit.line);
    expect(slice.content).toContain("return");
  });

  it("returns surrounding context lines", async () => {
    const root = makeRoot({ "src/app.ts": APP_TS });
    const results = await searchRepo(root, "return", { contextLines: 1 });

    expect(results[0].contextBefore).toEqual([
      "export function add(a: number, b: number): number {",
    ]);
    expect(results[0].contextAfter).toEqual(["}"]);
  });

  it("filters out matches in excluded paths", async () => {
    const root = makeRoot({
      "src/app.ts": "return 1;\n",
      "node_modules/dep.js": "return 2;\n",
    });
    const results = await searchRepo(root, "return");
    expect(results.map((r) => r.path)).toEqual(["src/app.ts"]);
  });

  it("returns no matches for an absent pattern", async () => {
    const root = makeRoot({ "src/app.ts": APP_TS });
    const results = await searchRepo(root, "no-such-token-xyz");
    expect(results).toEqual([]);
  });
});
