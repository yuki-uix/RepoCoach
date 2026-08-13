/**
 * Repository URL / local path parsing.
 *
 * Accepts:
 *   - https://github.com/owner/name[/tree/ref]
 *   - github.com/owner/name[/tree/ref] (scheme and www optional)
 *   - owner/name shorthand
 *   - a local path (absolute, explicitly relative `./…`/`../…`, or `file://…`)
 *
 * Anything that is not a recognisable GitHub URL is treated as a local path.
 * A bare two-segment input (`owner/name`) is always interpreted as a GitHub
 * shorthand, so local paths with exactly two segments must use `./` or an
 * absolute path.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ParsedRepoUrl =
  | { kind: "github"; owner: string; name: string; ref?: string }
  | { kind: "local"; path: string };

// GitHub user/org names allow alphanumerics and single hyphens (no leading or
// trailing hyphen, no dots). Repository names also allow dots and underscores.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const GITHUB_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/(.+?))?$/i;

export function parseRepoUrl(input: string): ParsedRepoUrl {
  const raw = input.trim();
  if (raw === "") {
    throw new Error("Repository URL or path is empty");
  }

  if (raw.startsWith("file:")) {
    return { kind: "local", path: parseFileUrl(raw) };
  }

  // Absolute paths and explicitly-relative paths are local.
  if (
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw === "." ||
    raw === ".."
  ) {
    return { kind: "local", path: resolve(raw) };
  }

  // A GitHub URL (with or without scheme / www). If it mentions github.com it
  // is clearly meant as a GitHub URL, so a malformed one is an error rather
  // than falling through to a local path.
  if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(raw)) {
    const match = raw.match(GITHUB_URL_RE);
    if (!match) {
      throw new Error(`Invalid GitHub repository URL: ${raw}`);
    }
    const owner = match[1];
    const name = match[2];
    const ref = match[3] || undefined;
    assertValidOwnerName(owner, name, raw);
    return ref === undefined
      ? { kind: "github", owner, name }
      : { kind: "github", owner, name, ref };
  }

  // `owner/name` shorthand (exactly two path segments).
  const shorthand = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) {
    const owner = shorthand[1];
    const name = shorthand[2];
    assertValidOwnerName(owner, name, raw);
    return { kind: "github", owner, name };
  }

  // Fall back to a local path (e.g. `my-repo`, `path/to/repo`).
  return { kind: "local", path: resolve(raw) };
}

function parseFileUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid file URL: ${raw}`);
  }
  if (url.protocol !== "file:") {
    throw new Error(`Expected a file:// URL, got: ${raw}`);
  }
  return fileURLToPath(url);
}

function assertValidOwnerName(owner: string, name: string, raw: string): void {
  if (!OWNER_RE.test(owner)) {
    throw new Error(`Invalid GitHub owner "${owner}" in "${raw}"`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid GitHub repository name "${name}" in "${raw}"`);
  }
}
