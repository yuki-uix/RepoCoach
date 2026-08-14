/**
 * @mc/core — the core package entry point.
 *
 * `createEngine` wires the parser and the store into a single engine handle.
 */

import { parse } from "./parse";

/** The public engine handle returned by `createEngine`. */
export interface Engine {
  run(raw: string): string;
}

/**
 * Create an engine backed by an in-memory store.
 */
export function createEngine(): Engine {
  return {
    run(raw: string): string {
      return parse(raw);
    },
  };
}
