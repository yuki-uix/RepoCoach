/**
 * Core domain types for taskloom.
 *
 * A task starts as a raw string, is split into fields by `parseTask`, is
 * checked by `validate`, and finally gets an `id` when it is stored.
 */

/** Task priority. Higher values are more urgent. */
export type Priority = "low" | "medium" | "high";

/** Task lifecycle status. */
export type Status = "todo" | "in_progress" | "done";

/** A task that has been parsed but not yet stored. */
export interface ParsedTask {
  title: string;
  assignee?: string;
  priority: Priority;
  status: Status;
}

/** A stored task. `id` is assigned by the store when the task is added. */
export interface Task extends ParsedTask {
  id: string;
}
