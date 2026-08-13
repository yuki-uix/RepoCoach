/**
 * Small string helpers.
 *
 * NOTE: this module shares its filename with `../render/format` but has a
 * completely different job. It formats durations and lists — it is not part
 * of the task creation call chain.
 */

/** Format a millisecond duration as a short human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Join a list of strings with commas and a final "and". */
export function formatList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0];
  }
  const rest = items.slice(0, -1).join(", ");
  return `${rest} and ${items[items.length - 1]}`;
}
