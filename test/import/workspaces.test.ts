import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  matchesWorkspace,
  matchesWorkspaceSet,
  resolveWorkspaces,
} from "../../src/import/workspaces.js";
import { createReader, type Repository } from "../../src/reader";
import { cleanupDir, writeFiles } from "../reader/helpers";

describe("matchesWorkspace glob semantics", () => {
  describe("?", () => {
    it("matches any single character", () => {
      expect(matchesWorkspace("packages/appX", "packages/app?")).toBe(true);
    });

    it("does not match zero characters", () => {
      expect(matchesWorkspace("packages/ap", "packages/app?")).toBe(false);
    });

    it("does not match more than one character", () => {
      expect(matchesWorkspace("packages/appXY", "packages/app?")).toBe(false);
    });

    it("does not cross a directory boundary", () => {
      expect(matchesWorkspace("packages/a/b", "packages/?")).toBe(false);
    });
  });

  describe("* and **", () => {
    it("* matches within a single segment but not across /", () => {
      expect(matchesWorkspace("packages/core", "packages/*")).toBe(true);
      expect(matchesWorkspace("packages/core/sub", "packages/*")).toBe(false);
    });

    it("** matches across nested segments", () => {
      expect(matchesWorkspace("packages/core/sub", "packages/**")).toBe(true);
    });
  });

  describe("regex metacharacters", () => {
    it("escapes + as a literal", () => {
      expect(matchesWorkspace("packages/a+b", "packages/a+b")).toBe(true);
      expect(matchesWorkspace("packages/aab", "packages/a+b")).toBe(false);
    });
  });
});

describe("matchesWorkspaceSet exclusion semantics", () => {
  it("excludes a directory matched by a `!` pattern", () => {
    expect(
      matchesWorkspaceSet("packages/core", ["packages/*", "!**/test/**"]),
    ).toBe(true);
    expect(
      matchesWorkspaceSet("packages/test", ["packages/*", "!**/test/**"]),
    ).toBe(false);
  });

  it("excludes nested directories under a negated pattern", () => {
    expect(
      matchesWorkspaceSet("packages/test/sub", ["packages/**", "!**/test/**"]),
    ).toBe(false);
    expect(
      matchesWorkspaceSet("packages/core/sub", ["packages/**", "!**/test/**"]),
    ).toBe(true);
  });

  it("matches nothing when there are only exclusions or no patterns", () => {
    expect(matchesWorkspaceSet("packages/core", ["!**/test/**"])).toBe(false);
    expect(matchesWorkspaceSet("packages/test", ["!**/test/**"])).toBe(false);
    expect(matchesWorkspaceSet("packages/core", [])).toBe(false);
  });

  it("applies exclusions regardless of their position in the list", () => {
    expect(
      matchesWorkspaceSet("packages/test", ["!**/test/**", "packages/*"]),
    ).toBe(false);
    expect(
      matchesWorkspaceSet("packages/core", ["!**/test/**", "packages/*"]),
    ).toBe(true);
  });
});

describe("resolveWorkspaces exclusions", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupDir(dir);
    }
  });

  it("drops a workspace excluded by `!` while keeping the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "repocoach-ws-"));
    tempDirs.push(root);
    writeFiles(root, {
      "packages/core/package.json": JSON.stringify({ name: "core" }),
      "packages/test/package.json": JSON.stringify({ name: "test" }),
    });

    const reader = createReader({ cacheRoot: join(root, ".cache") });
    const repo: Repository = {
      source: { kind: "local", path: root },
      rootDir: root,
      sha: "",
      meta: null,
    };
    const tree = reader.getTree(repo);
    const workspaces = resolveWorkspaces(reader, repo, tree, [
      "packages/*",
      "!**/test/**",
    ]);

    expect(workspaces.map((workspace) => workspace.path).sort()).toEqual([
      "packages/core",
    ]);
  });
});
