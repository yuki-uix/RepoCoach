/**
 * Storage abstraction.
 *
 * The main call chain relies on this interface via `MemoryStore`. Keeping the
 * interface separate means the store can be swapped (e.g. for a persistent
 * backend) without touching the rest of taskloom.
 */

import type { ParsedTask, Task } from "../types";

/** Contract for task storage backends. */
export interface TaskStore {
  /** Add a task and return it with its assigned id. */
  add(task: ParsedTask): Task;
  /** Number of tasks currently stored. */
  readonly size: number;
}
