/**
 * Task rendering.
 *
 * `formatTask` turns a stored task back into a single-line, human-readable
 * string. This module is the final step of the main call chain and is
 * unrelated to `../util/format`.
 */

import type { Task } from "../types";

/** Render a stored task as a single line of text. */
export function formatTask(task: Task): string {
  const assignee = task.assignee === undefined ? "unassigned" : task.assignee;
  return `[${task.status}] #${task.id} ${task.title} (${assignee}, ${task.priority})`;
}
