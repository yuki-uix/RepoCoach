/**
 * taskloom — a minimal task tracking library.
 *
 * This is the public entry point. `createTracker` wires together the whole
 * pipeline: parse → validate → store → render. See README.md for usage.
 */

import { parseTask } from "./parse/task";
import { validate } from "./parse/validate";
import { MemoryStore } from "./store/memory";
import { formatTask } from "./render/format";

/** The public tracker handle returned by `createTracker`. */
export interface Tracker {
  add(raw: string): string | null;
  count(): number;
}

/**
 * Create a task tracker backed by an in-memory store.
 *
 * `add` runs the full pipeline: it parses the raw string, validates the
 * result, stores the task and renders it back as a single line.
 */
export function createTracker(): Tracker {
  const store = new MemoryStore();

  return {
    add(raw: string): string | null {
      const task = parseTask(raw);
      const result = validate(task);
      if (!result.valid) {
        return null;
      }
      const stored = store.add(task);
      return formatTask(stored);
    },

    count(): number {
      return store.size;
    },
  };
}
