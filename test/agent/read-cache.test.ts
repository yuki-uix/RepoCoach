import { describe, expect, it } from "vitest";
import {
  MAX_CARRIED_CONTEXT_BYTES,
  SessionReadCache,
  byteLength,
  carriedContextFixedBytes,
  formatCarriedBlock,
  selectCarryRanges,
  type CachedRange,
} from "../../src/agent";

function range(
  path: string,
  startLine: number,
  endLine: number,
  content: string,
  lastUsed = 1,
): CachedRange {
  return { path, startLine, endLine, content, lastUsed, cited: false };
}

describe("SessionReadCache", () => {
  it("records a range with its content", () => {
    const cache = new SessionReadCache();
    cache.record("src/a.ts", 1, 3, "1 | one");
    expect(cache.ranges).toEqual([
      { path: "src/a.ts", startLine: 1, endLine: 3, content: "1 | one", lastUsed: 1, cited: false },
    ]);
  });

  it("refreshes an identical range instead of duplicating it", () => {
    const cache = new SessionReadCache();
    cache.record("src/a.ts", 1, 3, "old");
    cache.record("src/a.ts", 1, 3, "new");
    expect(cache.ranges).toHaveLength(1);
    expect(cache.ranges[0]?.content).toBe("new");
    expect(cache.ranges[0]?.lastUsed).toBe(2);
  });

  it("normalizes backslash paths to POSIX", () => {
    const cache = new SessionReadCache();
    cache.record("src\\a.ts", 1, 3, "x");
    expect(cache.ranges[0]?.path).toBe("src/a.ts");
  });

  it("marks a cached range as cited when the citation is a sub-range", () => {
    const cache = new SessionReadCache();
    cache.record("src/a.ts", 1, 10, "x");
    cache.markCited("src/a.ts", 3, 5);
    expect(cache.ranges[0]?.cited).toBe(true);
  });
});

describe("selectCarryRanges", () => {
  it("carries everything when the budget is large enough", () => {
    const cache = new SessionReadCache();
    cache.record("src/a.ts", 1, 1, "a");
    cache.record("src/b.ts", 1, 1, "b");

    const { carry, omitted } = selectCarryRanges(cache.ranges, 100_000);

    expect(carry.map((r) => r.path)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(omitted).toEqual([]);
  });

  it("prefers a cited range over a more recent uncited one", () => {
    const cache = new SessionReadCache();
    cache.record("src/recent.ts", 1, 1, "recent"); // lastUsed 1
    cache.record("src/cited.ts", 1, 1, "cited"); // lastUsed 2
    cache.markCited("src/cited.ts", 1, 1);

    // Budget fits exactly one entry: the fixed block overhead plus one entry.
    const oneEntryBytes = byteLength("src/cited.ts (lines 1-1):\ncited");
    const { carry, omitted } = selectCarryRanges(
      cache.ranges,
      carriedContextFixedBytes() + oneEntryBytes,
    );

    expect(carry.map((r) => r.path)).toEqual(["src/cited.ts"]);
    expect(omitted.map((r) => r.path)).toEqual(["src/recent.ts"]);
  });

  it("prefers the most recent range when nothing is cited", () => {
    const cache = new SessionReadCache();
    cache.record("src/older.ts", 1, 1, "older"); // lastUsed 1
    cache.record("src/newer.ts", 1, 1, "newer"); // lastUsed 2

    const oneEntryBytes = byteLength("src/newer.ts (lines 1-1):\nnewer");
    const { carry, omitted } = selectCarryRanges(
      cache.ranges,
      carriedContextFixedBytes() + oneEntryBytes,
    );

    expect(carry.map((r) => r.path)).toEqual(["src/newer.ts"]);
    expect(omitted.map((r) => r.path)).toEqual(["src/older.ts"]);
  });

  it("downgrades a range whose content does not fit the budget", () => {
    const cache = new SessionReadCache();
    cache.record("src/a.ts", 1, 1, "x");
    cache.record("src/big.ts", 1, 1, "y".repeat(5000));

    // Enough for the small entry but not the big one.
    const smallEntryBytes = byteLength("src/a.ts (lines 1-1):\nx");
    const { carry, omitted } = selectCarryRanges(
      cache.ranges,
      carriedContextFixedBytes() + smallEntryBytes + 1,
    );

    // The big range is more recent, so it is tried first; it does not fit and
    // is downgraded, then the small one is carried.
    expect(omitted.map((r) => r.path)).toEqual(["src/big.ts"]);
    expect(carry.map((r) => r.path)).toEqual(["src/a.ts"]);
  });
});

describe("formatCarriedBlock", () => {
  it("carries full content for carried ranges and lists only path+range for omitted ones", () => {
    const carried = [range("src/a.ts", 1, 3, "1 | one\n2 | two")];
    const omitted = [range("src/b.ts", 5, 9, "should not appear")];

    const block = formatCarriedBlock(carried, omitted);

    expect(block).toContain("src/a.ts (lines 1-3):");
    expect(block).toContain("2 | two");
    expect(block).toContain("content omitted");
    expect(block).toContain("src/b.ts (lines 5-9)");
    // The downgraded range's content must never leak into the block.
    expect(block).not.toContain("should not appear");
  });

  it("omits the downgraded section when nothing is downgraded", () => {
    const block = formatCarriedBlock([range("src/a.ts", 1, 1, "x")], []);
    expect(block).toContain("src/a.ts (lines 1-1):");
    expect(block).not.toContain("content omitted");
  });
});

describe("carried-context budget", () => {
  it("keeps the real formatCarriedBlock output within the cap for 1000 long-path ranges", () => {
    const cache = new SessionReadCache();
    for (let i = 0; i < 1000; i++) {
      const longPath = `src/deeply/nested/module-${i}/subdir/another-level/very-long-file-name-${i}.ts`;
      cache.record(longPath, 1, 50, `line ${i} content: ${"x".repeat(200)}`);
    }

    const { carry, omitted } = selectCarryRanges(cache.ranges, MAX_CARRIED_CONTEXT_BYTES);
    const block = formatCarriedBlock(carry, omitted);

    // The whole rendered block (lead + carried content + downgraded list) stays
    // within the cap regardless of how many ranges are downgraded.
    expect(byteLength(block)).toBeLessThanOrEqual(MAX_CARRIED_CONTEXT_BYTES);

    // Carried content still fills most of the budget — the reserved omitted
    // section and fixed deductions must not starve it.
    expect(byteLength(block)).toBeGreaterThan(MAX_CARRIED_CONTEXT_BYTES * 0.8);

    // The downgraded tail is collapsed to one marker, not enumerated 1:1.
    expect(block).toContain("more range(s)");
  });

  it("collapses the omitted list to a marker instead of enumerating every range", () => {
    const carried = [range("src/kept.ts", 1, 1, "kept")];
    const omitted = Array.from({ length: 100 }, (_, i) =>
      range(`src/omitted-${i}.ts`, 1, 1, "should not appear"),
    );

    const block = formatCarriedBlock(carried, omitted);

    expect(block).toContain("content omitted");
    expect(block).toContain("more range(s)");
    expect(block).not.toContain("should not appear");
    // The downgraded range count is collapsed, not listed one entry per range.
    expect(block).not.toContain("src/omitted-99.ts");
  });
});
