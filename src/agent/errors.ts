/**
 * Shared error helpers for the agent module.
 *
 * `describeError` turns any thrown value into a safe string; `formatZodError`
 * renders zod issues as a single line the model can act on. Both are used to
 * turn failures into tool results instead of aborting the loop.
 */

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
}

/** Flatten zod issues into `path: message; path: message; ...`. */
export function formatZodError(error: { issues: readonly ZodIssueLike[] }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
