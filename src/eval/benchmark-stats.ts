/**
 * Benchmark summary statistics — median + min/max over the per-run values of a
 * repeated benchmark.
 *
 * Degenerate-input behaviour. A benchmark metric is reported as a median with a
 * (min–max) spread so a single outlier run cannot drag an average; the spread
 * is what makes the outlier visible instead of hidden. The degenerate cases are
 * handled explicitly, never as NaN or a fake number:
 *
 *   input                 | median            | spread
 *   ----------------------|-------------------|----------------------------
 *   empty (no samples)    | undefined         | undefined
 *   single sample         | that sample       | { min = max = median = it }
 *   even number of samples| mean of the two   | { min, median, max }
 *                         | middle samples    |
 *   odd number of samples | the middle sample | { min, median, max }
 *
 * `undefined` (not `NaN`, not `0`) is the empty result: a missing measurement
 * must never read as a valid 0, which is the same rule the ratio metrics in
 * metrics.ts already follow (their `evaluable` flag + `undefined` ratio).
 */

/** The min / median / max of a non-empty sample. */
export interface Spread {
  min: number;
  median: number;
  max: number;
}

/**
 * Median of `values`. The even-length median is the mean of the two middle
 * values after sorting (the standard definition for a sample of numbers).
 * `undefined` for an empty sample — there is no median of nothing.
 */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The min / median / max of `values`, for a summary that keeps the outlier
 * visible. `undefined` for an empty sample; a single sample collapses to
 * `min === median === max === sample` (there is no spread of one point).
 */
export function spread(values: readonly number[]): Spread | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min, median: med, max };
}
