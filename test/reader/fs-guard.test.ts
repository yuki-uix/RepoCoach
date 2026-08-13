import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInRepo } from "../../src/reader/fs-guard";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-guard-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveInRepo", () => {
  it("resolves a normal relative path inside the repo", () => {
    const root = makeRepo();
    writeFileSync(join(root, "a.txt"), "x");
    expect(resolveInRepo(root, "a.txt")).toEqual({
      resolved: join(root, "a.txt"),
      realRel: "a.txt",
    });
  });

  it("rejects a ../ traversal outside the repo", () => {
    const root = makeRepo();
    expect(() => resolveInRepo(root, "../secret.txt")).toThrow(
      /escapes repository root/,
    );
  });

  it("rejects an absolute path outside the repo", () => {
    const root = makeRepo();
    expect(() => resolveInRepo(root, "/etc/passwd")).toThrow(
      /escapes repository root/,
    );
  });

  it("rejects a symlink pointing outside the repo", () => {
    const root = makeRepo();
    const outside = makeRepo();
    const target = join(outside, "secret.txt");
    writeFileSync(target, "secret");
    symlinkSync(target, join(root, "link.txt"));
    expect(() => resolveInRepo(root, "link.txt")).toThrow(
      /escapes repository root/,
    );
  });

  it("allows a symlink pointing inside the repo", () => {
    const root = makeRepo();
    writeFileSync(join(root, "real.txt"), "hello");
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
    expect(resolveInRepo(root, "alias.txt")).toEqual({
      resolved: join(root, "alias.txt"),
      realRel: "real.txt",
    });
  });

  it("rejects a missing file", () => {
    const root = makeRepo();
    expect(() => resolveInRepo(root, "missing.txt")).toThrow();
  });
});
