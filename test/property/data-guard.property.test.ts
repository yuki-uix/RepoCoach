/**
 * Property tests for the data-guard endpoints: the two byte caps that close
 * over untrusted content must hold for *every* input, not just the hand-picked
 * adversarial cases the coverage suite enumerates.
 *
 *   ∀ content, meta, N:   byteLength(capRepoData(content, meta, N)) ≤ N
 *   ∀ ranges:             byteLength(buildCarriedBlock(ranges, CAP).content) ≤ CAP
 *
 * The marker-heavy / multibyte / multi-line arbitraries are what a hand-written
 * test would miss: they force the escaped-size billing and the multi-byte-safe
 * truncation to be exercised across a space a fixed case never samples.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_CARRIED_CONTEXT_BYTES,
  REPO_DATA_END,
  UNTRUSTED_DATA_START,
  buildCarriedBlock,
  byteLength,
  capRepoData,
  type CachedRange,
  type RepoDataMeta,
} from "../../src/agent";

/** Content spanning ASCII, multibyte, marker-heavy and multi-line shapes. */
const contentArb = fc.oneof(
  fc.string({ maxLength: 2_000 }),
  fc.string({ unit: "binary", maxLength: 400 }),
  fc.constant(REPO_DATA_END.repeat(10)),
  fc.constant("a\n".repeat(200)),
);

const metaArb: fc.Arbitrary<RepoDataMeta> = fc.record({
  tool: fc.string({ maxLength: 30 }),
  path: fc.string({ maxLength: 30 }),
});

describe("capRepoData property", () => {
  it("never returns a wrapped message larger than the terminal cap", () => {
    fc.assert(
      fc.property(contentArb, metaArb, fc.nat({ max: 8_192 }), (content, meta, n) => {
        expect(byteLength(capRepoData(content, meta, n))).toBeLessThanOrEqual(n);
      }),
      { numRuns: 300 },
    );
  });
});

/** A cached range whose content may carry forged markers and multibyte text. */
const rangeArb: fc.Arbitrary<CachedRange> = fc
  .record({
    path: fc.string({ minLength: 1, maxLength: 20 }),
    startLine: fc.nat({ max: 100 }),
    offset: fc.nat({ max: 50 }),
    content: fc.oneof(
      fc.string({ maxLength: 400 }),
      fc.string({ unit: "binary", maxLength: 100 }),
      fc.constant(REPO_DATA_END.repeat(5)),
    ),
    cited: fc.boolean(),
  })
  .map(({ path, startLine, offset, content, cited }) => ({
    path,
    startLine,
    endLine: startLine + offset,
    content,
    lastUsed: 0,
    cited,
  }));

describe("buildCarriedBlock property", () => {
  it("caps the wrapped carried-context block and carries only a subset", () => {
    fc.assert(
      fc.property(fc.array(rangeArb, { maxLength: 40 }), (ranges) => {
        const built = buildCarriedBlock(ranges, MAX_CARRIED_CONTEXT_BYTES);
        expect(byteLength(built.content)).toBeLessThanOrEqual(MAX_CARRIED_CONTEXT_BYTES);
        expect(built.content).toContain(UNTRUSTED_DATA_START);
        // Carried ranges are the exact records whose content landed in context —
        // never more than the input, and never fabricated entries.
        expect(built.carried.length).toBeLessThanOrEqual(ranges.length);
        for (const carried of built.carried) {
          expect(ranges.includes(carried)).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});
