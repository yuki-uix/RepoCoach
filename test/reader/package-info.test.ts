import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPackageInfo,
  parsePnpmWorkspacePackages,
} from "../../src/reader/package-info";
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

  it("merges pnpm-workspace.yaml packages with package.json workspaces", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - apps/*\n",
    });
    expect(getPackageInfo(root).workspaces).toEqual(["apps/*", "packages/*"]);
  });

  it("detects pnpm workspaces when package.json has no workspaces field", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({ name: "pnpm" }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    });
    const info = getPackageInfo(root);
    expect(info.workspaces).toEqual(["packages/*"]);
    expect(info.warnings).toEqual([]);
  });

  it("parses a multi-line flow `packages` list in pnpm-workspace.yaml", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({ name: "pnpm" }),
      "pnpm-workspace.yaml": "packages:\n  [\n    'packages/*',\n    'apps/*'\n  ]\n",
    });
    const info = getPackageInfo(root);
    expect(info.workspaces).toEqual(["packages/*", "apps/*"]);
    expect(info.warnings).toEqual([]);
  });

  it("degrades to an empty list with a warning on a malformed pnpm-workspace.yaml", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({ name: "pnpm" }),
      "pnpm-workspace.yaml": "packages:\n  oops\n",
    });
    const info = getPackageInfo(root);
    expect(info.workspaces).toEqual([]);
    expect(info.warnings).toEqual(["pnpm-workspace.yaml `packages` must be a list"]);
  });
});

describe("pnpm-workspace.yaml read gate", () => {
  it("rejects a pnpm-workspace.yaml symlink pointing outside the repo", () => {
    const root = makeRoot({ "package.json": JSON.stringify({ name: "x" }) });
    const outside = mkdtempSync(join(tmpdir(), "repocoach-pnpm-outside-"));
    tempDirs.push(outside);
    const target = join(outside, "secret.yaml");
    writeFileSync(target, "packages:\n  - 'top-secret'\n");
    symlinkSync(target, join(root, "pnpm-workspace.yaml"));

    let message = "";
    try {
      getPackageInfo(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/escapes repository root/);
    expect(message).not.toContain("top-secret");
  });

  it("rejects a pnpm-workspace.yaml symlink whose real target is a secret file", () => {
    const root = makeRoot({
      "package.json": JSON.stringify({ name: "x" }),
      ".env": "SECRET=1\n",
    });
    symlinkSync(join(root, ".env"), join(root, "pnpm-workspace.yaml"));

    let message = "";
    try {
      getPackageInfo(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not readable/);
    expect(message).not.toContain(".env");
  });

  it("rejects an oversized pnpm-workspace.yaml (over 512 KiB)", () => {
    const big = `packages:\n  - "${"x".repeat(512 * 1024)}"\n`;
    const root = makeRoot({
      "package.json": JSON.stringify({ name: "big" }),
      "pnpm-workspace.yaml": big,
    });
    expect(() => getPackageInfo(root)).toThrow(/size limit/);
  });
});

describe("parsePnpmWorkspacePackages", () => {
  it("parses a block list of unquoted patterns", () => {
    expect(
      parsePnpmWorkspacePackages("packages:\n  - packages/*\n  - apps/*\n"),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
  });

  it("strips single and double quotes", () => {
    expect(
      parsePnpmWorkspacePackages("packages:\n  - 'packages/*'\n  - \"apps/*\"\n"),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
  });

  it("ignores comments and blank lines", () => {
    expect(
      parsePnpmWorkspacePackages(
        "packages:  # the workspace members\n\n  # a comment\n  - packages/*  # trailing\n\n  - \"apps/*\"\n",
      ),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
  });

  it("returns an empty list for an inline empty packages list", () => {
    expect(parsePnpmWorkspacePackages("packages: []\n")).toEqual({ packages: [] });
    expect(parsePnpmWorkspacePackages("packages: []  # none\n")).toEqual({
      packages: [],
    });
  });

  it("parses a single-line flow sequence", () => {
    expect(
      parsePnpmWorkspacePackages("packages: ['packages/*', \"apps/*\"]\n"),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
    expect(parsePnpmWorkspacePackages("packages: [packages/*, apps/*]\n")).toEqual({
      packages: ["packages/*", "apps/*"],
    });
  });

  it("tolerates a trailing comma and whitespace in a flow sequence", () => {
    expect(
      parsePnpmWorkspacePackages("packages: [packages/*, apps/*, ]\n"),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
    expect(
      parsePnpmWorkspacePackages("packages: [  packages/*  ,  \"apps/*\"  ]\n"),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
  });

  it("tolerates a comment after the closing bracket", () => {
    expect(
      parsePnpmWorkspacePackages("packages: ['packages/*']  # members\n"),
    ).toEqual({ packages: ["packages/*"] });
  });

  it("keeps `!` exclusion patterns in block and flow forms, quoted", () => {
    expect(
      parsePnpmWorkspacePackages("packages:\n  - packages/*\n  - '!**/test/**'\n"),
    ).toEqual({ packages: ["packages/*", "!**/test/**"] });
    expect(
      parsePnpmWorkspacePackages("packages: ['packages/*', \"!**/test/**\"]\n"),
    ).toEqual({ packages: ["packages/*", "!**/test/**"] });
  });

  it("keeps a pure-exclusion list without throwing", () => {
    expect(
      parsePnpmWorkspacePackages("packages:\n  - '!**/test/**'\n"),
    ).toEqual({ packages: ["!**/test/**"] });
    expect(
      parsePnpmWorkspacePackages("packages: [\"!**/test/**\"]\n"),
    ).toEqual({ packages: ["!**/test/**"] });
  });

  it("drops an unquoted `!` exclusion and warns (it is a YAML tag)", () => {
    // In YAML, `!` opens a tag, so an unquoted `!**/test/**` is not a pattern.
    // pnpm requires quoting these; the degradation is surfaced, not silent.
    expect(
      parsePnpmWorkspacePackages("packages:\n  - packages/*\n  - !**/test/**\n"),
    ).toEqual({
      packages: ["packages/*"],
      warning: "pnpm-workspace.yaml `packages` contains entries that are not glob patterns",
    });
  });

  it("parses a multi-line flow sequence", () => {
    expect(
      parsePnpmWorkspacePackages(
        "packages:\n  [\n    'packages/*',\n    'apps/*'\n  ]\n",
      ),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
  });

  it("resolves anchors and aliases", () => {
    expect(
      parsePnpmWorkspacePackages(
        "base: &members\n  - packages/*\n  - apps/*\npackages: *members\n",
      ),
    ).toEqual({ packages: ["packages/*", "apps/*"] });
  });

  it("stops reading at a following top-level key", () => {
    expect(
      parsePnpmWorkspacePackages("packages:\n  - packages/*\ncatalog:\n  zod: ^3\n"),
    ).toEqual({ packages: ["packages/*"] });
  });

  it("degrades with a warning on duplicate `packages` keys", () => {
    expect(
      parsePnpmWorkspacePackages("packages:\n  - packages/*\npackages: [ignored/*]\n"),
    ).toEqual({
      packages: [],
      warning: "pnpm-workspace.yaml is not valid YAML",
    });
  });

  it("degrades with a warning on a non-mapping root", () => {
    expect(parsePnpmWorkspacePackages("not yaml\n")).toEqual({
      packages: [],
      warning: "pnpm-workspace.yaml must be a YAML mapping",
    });
    expect(parsePnpmWorkspacePackages("")).toEqual({
      packages: [],
      warning: "pnpm-workspace.yaml must be a YAML mapping",
    });
  });

  it("degrades with a warning when `packages` is missing", () => {
    expect(parsePnpmWorkspacePackages("catalog:\n  zod: ^3\n")).toEqual({
      packages: [],
      warning: "pnpm-workspace.yaml has no `packages` field",
    });
  });

  it("degrades with a warning when `packages` is not a list", () => {
    expect(parsePnpmWorkspacePackages("packages:\n  packages/*\n")).toEqual({
      packages: [],
      warning: "pnpm-workspace.yaml `packages` must be a list",
    });
  });

  it("treats a flow/block mix as invalid YAML rather than throwing", () => {
    expect(parsePnpmWorkspacePackages("packages: [\n  - packages/*\n]\n")).toEqual({
      packages: [],
      warning: "pnpm-workspace.yaml is not valid YAML",
    });
  });

  it("degrades with a warning on inconsistent item indentation", () => {
    expect(parsePnpmWorkspacePackages("packages:\n  - packages/*\n  -foo\n")).toEqual({
      packages: [],
      warning: "pnpm-workspace.yaml is not valid YAML",
    });
  });
});
