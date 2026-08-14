import { describe, expect, it } from "vitest";
import { matchesWorkspace } from "../../src/import/workspaces.js";

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
