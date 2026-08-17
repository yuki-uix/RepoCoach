import { describe, expect, it } from "vitest";
import { median, spread } from "../../src/eval/benchmark-stats.js";

describe("median", () => {
  it("returns undefined for an empty sample, never NaN", () => {
    expect(median([])).toBeUndefined();
  });

  it("returns the single sample for a one-element sample", () => {
    expect(median([7])).toBe(7);
  });

  it("returns the middle value for an odd-length sample", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length sample", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("spread", () => {
  it("returns undefined for an empty sample, never a fake min/max", () => {
    expect(spread([])).toBeUndefined();
  });

  it("collapses min/median/max to the single sample", () => {
    expect(spread([5])).toEqual({ min: 5, median: 5, max: 5 });
  });

  it("returns min/median/max for an even-length sample", () => {
    expect(spread([10, 2, 8, 4])).toEqual({ min: 2, median: 6, max: 10 });
  });

  it("returns min/median/max for an odd-length sample", () => {
    expect(spread([7, 3, 9])).toEqual({ min: 3, median: 7, max: 9 });
  });
});
