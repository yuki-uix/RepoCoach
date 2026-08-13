/**
 * Task validation.
 *
 * `validate` checks a parsed task and reports whether it is safe to store.
 * `parseTask` deliberately does NOT validate — callers must run this check
 * before adding the task to a store.
 */

import type { ParsedTask } from "../types";

/** Validation result: a boolean and an optional reason for failure. */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Return whether a parsed task is acceptable.
 *
 * Rules:
 *   - the title must not be empty
 *   - the assignee, when present, must not be empty
 */
export function validate(task: ParsedTask): ValidationResult {
  if (task.title.trim() === "") {
    return { valid: false, reason: "title is empty" };
  }
  if (task.assignee !== undefined && task.assignee.trim() === "") {
    return { valid: false, reason: "assignee is empty" };
  }
  return { valid: true };
}
