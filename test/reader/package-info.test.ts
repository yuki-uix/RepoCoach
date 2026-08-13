import { mkdtempSync, rmSync } from "node:fs";
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
});
