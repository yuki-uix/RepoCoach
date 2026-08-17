/**
 * Property tests for `fitSourceLines`: the read-file line fitter must return
 * whole lines only and stay within budget for *every* content/budget/start-line
 * combination.
 *
 *   ∀ content, budget, startLine:
 *     - returned `content` is a whole-line prefix of the input (or a byte-prefix
 *       of the first line when even that line does not fit);
 *     - its numbered form (the exact shape repo_read_file sends) is ≤ budget;
 *     - `truncated` is exactly "fewer than all lines were kept".
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { byteLength, fitSourceLines } from "../../src/agent";
import { lineNumberPrefix } from "../../src/agent/limits.js";

/** The numbered form repo_read_file renders: `NNNN | ` prefix per line. */
function numberLines(content: string, startLine: number): string {
  if (content === "") {
    return "";
  }
  return content
    .split("\n")
    .map((line, index) => `${lineNumberPrefix(startLine + index)}${line}`)
    .join("\n");
}

describe("fitSourceLines property", () => {
  it("returns whole lines and never exceeds the budget", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 2_000 }),
          fc.string({ unit: "binary", maxLength: 500 }),
        ),
        fc.nat({ max: 2_048 }),
        fc.nat({ max: 9_999 }).map((n) => n + 1),
        (content, budget, startLine) => {
          const result = fitSourceLines(content, budget, startLine);
          const sourceLines = content.split("\n");

          if (result.keptLines === 0) {
            // Even the first line did not fit: a byte-prefix of it is returned
            // and nothing is citable.
            expect(result.content.split("\n")).toHaveLength(1);
            expect(sourceLines[0]?.startsWith(result.content)).toBe(true);
            expect(byteLength(result.content)).toBeLessThanOrEqual(budget);
          } else {
            // Whole lines only, exactly the first `keptLines` source lines.
            expect(result.content.split("\n")).toEqual(sourceLines.slice(0, result.keptLines));
            expect(byteLength(numberLines(result.content, startLine))).toBeLessThanOrEqual(budget);
          }

          // `truncated` is true iff some source line was dropped or cut.
          expect(result.truncated).toBe(result.keptLines < sourceLines.length);
        },
      ),
      { numRuns: 300 },
    );
  });
});
