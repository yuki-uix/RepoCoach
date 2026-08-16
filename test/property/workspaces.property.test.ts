/**
 * Property tests for the workspace glob layer.
 *
 *   ∀ YAML input:    parsePnpmWorkspacePackages never throws, returns a valid shape,
 *                    and round-trips a `packages` list through the real parser
 *   ∀ dir, patterns: matchesWorkspaceSet never throws, and its semantics equal
 *                    "some positive matches AND no exclusion matches"
 *
 * The pnpm `packages` list is untrusted repository data, so a malformed
 * manifest must degrade to `[]` + a warning rather than abort an import; the
 * set semantics must match pnpm (positive union, then exclusions subtract).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePnpmWorkspacePackages } from "../../src/reader";
import { matchesWorkspace, matchesWorkspaceSet } from "../../src/import/workspaces.js";

describe("parsePnpmWorkspacePackages property", () => {
  it("never throws and always returns a valid shape", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (content) => {
        const result = parsePnpmWorkspacePackages(content);
        expect(Array.isArray(result.packages)).toBe(true);
        expect(result.packages.every((item) => typeof item === "string")).toBe(true);
        expect(result.warning === undefined || typeof result.warning === "string").toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips a `packages` glob list through the real YAML parser", () => {
    const globChar = fc.constantFrom("a", "b", "c", "0", "1", "*", "?", "-", "_", ".");
    const globsArb = fc.array(fc.string({ unit: globChar, minLength: 1, maxLength: 12 }), {
      maxLength: 5,
    });
    fc.assert(
      fc.property(globsArb, (globs) => {
        const yaml = `packages:\n${globs.map((glob) => `  - "${glob}"`).join("\n")}`;
        expect(parsePnpmWorkspacePackages(yaml).packages).toEqual(globs);
      }),
      { numRuns: 200 },
    );
  });
});

describe("matchesWorkspaceSet property", () => {
  /** A realistic path: `a/b-c`, `packages/core`, etc. */
  const dirArb = fc.string({
    unit: fc.constantFrom("a", "b", "c", "core", "apps", "packages", "test", "/", "-", "."),
    minLength: 1,
    maxLength: 16,
  });
  /** A positive glob: `*`, `?`, `**` and literals (never a leading `!`). */
  const globArb = fc.string({
    unit: fc.constantFrom("a", "b", "c", "core", "apps", "*", "?", "/", "-", "."),
    minLength: 1,
    maxLength: 16,
  });

  it("equals 'some positive matches AND no exclusion matches'", () => {
    fc.assert(
      fc.property(
        dirArb,
        fc.array(globArb, { maxLength: 4 }),
        fc.array(globArb, { maxLength: 4 }),
        (dir, positives, negatives) => {
          const patterns = [...positives, ...negatives.map((pattern) => `!${pattern}`)];
          const expected =
            positives.some((pattern) => matchesWorkspace(dir, pattern)) &&
            !negatives.some((pattern) => matchesWorkspace(dir, pattern));
          expect(matchesWorkspaceSet(dir, patterns)).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never throws for arbitrary (even malformed) patterns", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.array(fc.string({ maxLength: 30 }), { maxLength: 6 }),
        (dir, patterns) => {
          expect(() => matchesWorkspaceSet(dir, patterns)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});
