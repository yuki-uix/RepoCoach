/**
 * @pnpm-mono/core — the core package entry point.
 *
 * `createEngine` returns the public engine handle.
 */

export interface Engine {
  run(raw: string): string;
}

/** Create the core engine. */
export function createEngine(): Engine {
  return {
    run(raw: string): string {
      return raw.trim();
    },
  };
}
