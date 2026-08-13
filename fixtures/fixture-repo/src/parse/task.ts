/**
 * Task parsing.
 *
 * `parseTask` converts a raw string such as `"fix login bug @alice !high
 * #in_progress"` into a structured `ParsedTask`. It splits tokens and
 * recognises the `@assignee`, `!priority` and `#status` markers; everything
 * else becomes part of the title.
 *
 * Parsing and validation are separate steps — see `./validate`.
 */

import type { ParsedTask, Priority, Status } from "../types";

/**
 * Parse a raw task string into a `ParsedTask`.
 *
 * Recognised markers (order does not matter):
 *   - `@name`                 assignee
 *   - `!low|medium|high`      priority (default `medium`)
 *   - `#todo|in_progress|done` status (default `todo`)
 */
export function parseTask(raw: string): ParsedTask {
  const tokens = raw.trim().split(/\s+/);
  const title: string[] = [];
  let assignee: string | undefined;
  let priority: Priority = "medium";
  let status: Status = "todo";

  for (const token of tokens) {
    const value = token.slice(1);

    if (token.startsWith("@") && token.length > 1) {
      assignee = value;
    } else if (token.startsWith("!") && isPriority(value)) {
      priority = value;
    } else if (token.startsWith("#") && isStatus(value)) {
      status = value;
    } else {
      title.push(token);
    }
  }

  return {
    title: title.join(" "),
    ...(assignee === undefined ? {} : { assignee }),
    priority,
    status,
  };
}

function isPriority(value: string): value is Priority {
  return value === "low" || value === "medium" || value === "high";
}

function isStatus(value: string): value is Status {
  return value === "todo" || value === "in_progress" || value === "done";
}
