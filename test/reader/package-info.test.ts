import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPackageInfo } from "../../src/reader/package-info";
import { writeFiles } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-pkg-"));
  tempDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

describe("getPackageInfo", () => {
  it("summarizes name, scripts and dependency names", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({
        name: "demo",
        scripts: { build: "tsc", test: "vitest" },
        dependencies: { zod: "^4.0.0" },
        devDependencies: { vitest: "^4.0.0" },
      }),
    });
    const info = getPackageInfo(root);
    expect(info.name).toBe("demo");
    expect(info.scripts).toEqual(["build", "test"]);
    expect(info.dependencies.sort()).toEqual(["vitest", "zod"]);
    expect(info.workspaces).toEqual([]);
  });

  it("parses array workspaces for monorepos", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
    });
    expect(getPackageInfo(root).workspaces).toEqual([
      "packages/*",
      "apps/*",
    ]);
  });

  it("parses the object form of workspaces", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
    });
    expect(getPackageInfo(root).workspaces).toEqual(["packages/*"]);
  });

  it("throws on invalid JSON", () => {
    const root = makeRoot({ "package.json": "{ not json" });
    expect(() => getPackageInfo(root)).toThrow(/not valid JSON/);
  });

  it("rejects a package.json symlink pointing outside the repo", () => {
    const root = makeRoot({});
    const outside = mkdtempSync(join(tmpdir(), "repocoach-pkg-outside-"));
    tempDirs.push(outside);
    const target = join(outside, "secret.json");
    writeFileSync(target, JSON.stringify({ name: "top-secret" }));
    symlinkSync(target, join(root, "package.json"));

    let message = "";
    try {
      getPackageInfo(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/escapes repository root/);
    expect(message).not.toContain("top-secret");
  });

  it("rejects a package.json symlink whose real target is a secret file", () => {
    const root = makeRoot({ ".env": "SECRET=1\n" });
    symlinkSync(join(root, ".env"), join(root, "package.json"));

    let message = "";
    try {
      getPackageInfo(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not readable/);
    expect(message).not.toContain(".env");
  });

  it("rejects an oversized package.json (over 512 KiB)", () => {
    const big = JSON.stringify({
      name: "big",
      scripts: { build: "x".repeat(512 * 1024) },
    });
    const root = makeRoot({ "package.json": big });
    expect(() => getPackageInfo(root)).toThrow(/size limit/);
  });

  it("reads a package.json symlink whose real target is readable JSON", () => {
    const root = makeRoot({
      "real.json": JSON.stringify({ name: "linked", scripts: { start: "node" } }),
    });
    symlinkSync(join(root, "real.json"), join(root, "package.json"));
    const info = getPackageInfo(root);
    expect(info.name).toBe("linked");
    expect(info.scripts).toEqual(["start"]);
  });
});
