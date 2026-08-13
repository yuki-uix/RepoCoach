/**
 * In-memory task storage.
 *
 * Tasks are kept in a plain array for the lifetime of the process. This is
 * the only storage backend in taskloom.
 */

import type { ParsedTask, Task } from "../types";
import type { TaskStore } from "./interface";

/** A `TaskStore` that keeps tasks in memory. */
export class MemoryStore implements TaskStore {
  private tasks: Task[] = [];
  private nextId = 1;

  /** Add a task, assign it an id and return the stored task. */
  add(task: ParsedTask): Task {
    const stored: Task = { ...task, id: String(this.nextId) };
    this.nextId += 1;
    this.tasks.push(stored);
    return stored;
  }

  /** Number of tasks currently stored. */
  get size(): number {
    return this.tasks.length;
  }
}
