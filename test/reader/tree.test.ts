import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTree } from "../../src/reader/tree";
import { writeFiles } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-tree-"));
  tempDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

describe("getTree", () => {
  it("returns sorted relative paths and sizes", () => {
    const root = makeRoot({
      "src/b.ts": "const b = 1;\n",
      "src/a.ts": "const a = 1;\n",
      "README.md": "# hi\n",
    });
    const tree = getTree(root);
    expect(tree.map((e) => e.path)).toEqual([
      "README.md",
      "src/a.ts",
      "src/b.ts",
    ]);
    for (const entry of tree) {
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it("filters out excluded and oversized files", () => {
    const root = makeRoot({
      "node_modules/dep.js": "x",
      "dist/bundle.js": "x",
      ".env": "SECRET=1",
      "src/app.min.js": "x",
      "src/app.ts": "hello",
      "big.txt": "z".repeat(100),
    });
    const tree = getTree(root, { maxFileSize: 10 });
    expect(tree.map((e) => e.path)).toEqual(["src/app.ts"]);
  });

  it("does not surface a symlink whose alias name looks readable", () => {
    const root = makeRoot({
      "real.ts": "export const x = 1;\n",
      ".env": "SECRET=1\n",
    });
    symlinkSync(join(root, ".env"), join(root, "config.ts"));
    expect(getTree(root).map((e) => e.path)).toEqual(["real.ts"]);
  });
});
