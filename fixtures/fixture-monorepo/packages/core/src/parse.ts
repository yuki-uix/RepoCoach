/**
 * @mc/core parsing.
 *
 * `parse` normalises a raw string into a canonical form.
 */

export function parse(raw: string): string {
  return raw.trim().toLowerCase();
}
