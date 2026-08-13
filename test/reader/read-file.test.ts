import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSlice } from "../../src/reader/read-file";
import { writeFiles } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-read-"));
  tempDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

describe("readFileSlice", () => {
  it("returns the full file by default with 1-based line numbers", () => {
    const root = makeRoot({ "a.txt": "one\ntwo\nthree\n" });
    const slice = readFileSlice(root, "a.txt");
    expect(slice.content).toBe("one\ntwo\nthree");
    expect(slice.startLine).toBe(1);
    expect(slice.endLine).toBe(3);
    expect(slice.totalLines).toBe(3);
  });

  it("slices a line range", () => {
    const root = makeRoot({ "a.txt": "one\ntwo\nthree\nfour\n" });
    const slice = readFileSlice(root, "a.txt", 2, 3);
    expect(slice.content).toBe("two\nthree");
    expect(slice.startLine).toBe(2);
    expect(slice.endLine).toBe(3);
    expect(slice.totalLines).toBe(4);
  });

  it("clamps an out-of-range end line", () => {
    const root = makeRoot({ "a.txt": "one\ntwo\n" });
    const slice = readFileSlice(root, "a.txt", 2, 99);
    expect(slice.content).toBe("two");
    expect(slice.endLine).toBe(2);
  });

  it("rejects oversized files", () => {
    const root = makeRoot({ "big.ts": "x".repeat(200) });
    expect(() =>
      readFileSlice(root, "big.ts", undefined, undefined, { maxFileSize: 10 }),
    ).toThrow(/size limit/);
  });

  it("rejects binary files", () => {
    const root = makeRoot({});
    writeFileSync(join(root, "blob.txt"), Buffer.from([0x00, 0x01, 0x02]));
    expect(() => readFileSlice(root, "blob.txt")).toThrow(/binary/);
  });

  it("rejects secret files", () => {
    const root = makeRoot({ ".env": "SECRET=1\n" });
    expect(() => readFileSlice(root, ".env")).toThrow(/excluded/);
  });

  it("rejects path traversal", () => {
    const root = makeRoot({ "a.txt": "x" });
    expect(() => readFileSlice(root, "../a.txt")).toThrow(/escapes/);
  });
});
