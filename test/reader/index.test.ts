import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReader } from "../../src/reader";
import { cleanupDir, createTempRepo } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupDir(dir);
  }
});

describe("createReader", () => {
  it("imports a local repo and exposes tree/search/read/package-info", async () => {
    const repo = await createTempRepo({
      "package.json": JSON.stringify({
        name: "demo",
        scripts: { test: "vitest" },
      }),
      "src/app.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    });
    tempDirs.push(repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const reader = createReader({ cacheRoot });
    const imported = await reader.importRepository(repo.dir);

    // A clean local git root is pinned to a clone, so rootDir is not the tree.
    expect(imported.rootDir).not.toBe(repo.dir);
    expect(imported.sha).toBe(repo.sha);
    expect(imported.meta).toBeNull();

    expect(reader.getTree(imported).map((e) => e.path)).toContain("src/app.ts");
    expect((await reader.search(imported, "return")).map((m) => m.line)).toEqual([
      2,
    ]);
    expect(reader.readFile(imported, "src/app.ts", 2, 2).content).toContain(
      "return",
    );
    expect(reader.getPackageInfo(imported).name).toBe("demo");
  });

  it("enforces reader maxFileSize on package-info reads", async () => {
    const big = JSON.stringify({
      name: "big",
      scripts: { build: "x".repeat(2048) },
    });
    const repo = await createTempRepo({ "package.json": big });
    tempDirs.push(repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);

    const reader = createReader({ cacheRoot, maxFileSize: 1024 });
    const imported = await reader.importRepository(repo.dir);

    expect(() => reader.getPackageInfo(imported)).toThrow(/size limit/);
  });
});
