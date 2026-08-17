/**
 * Readable-file filters.
 *
 * A file is readable text only if it is not on the path/secret/minified
 * blacklist, has a text extension, is under the size limit, and does not look
 * binary. Tree traversal uses `isIncludedInTree` (path + extension + size);
 * file reads additionally run the binary probe on the first 8 KiB.
 */

import { sep } from "node:path";

export const DEFAULT_MAX_FILE_SIZE = 512 * 1024; // 512 KiB

/** Directory segments never descended into or returned by the reader. */
export const EXCLUDED_DIR_NAMES = [
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  "out",
  ".next",
  ".turbo",
  ".cache",
] as const;

const SECRET_BASENAME_RE =
  /^(\.env(\..*)?|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|\.npmrc)$/i;

const MINIFIED_RE = /\.min\.(?:js|mjs|cjs|jsx|ts|tsx|css)$/i;

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx",
  "txt", "text", "rst",
  "yml", "yaml", "toml", "ini", "cfg", "conf",
  "html", "htm", "css", "scss", "sass", "less", "svg",
  "sh", "bash", "zsh", "fish", "ps1",
  "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "swift", "scala",
  "vue", "svelte", "astro", "sql", "graphql", "gql", "prisma", "proto",
  "xml", "lock",
]);

const EXACT_TEXT_FILES = new Set([
  "makefile", "dockerfile", "license", "changelog", "readme",
  ".gitignore", ".gitattributes", ".editorconfig",
]);

export interface FileFilterOptions {
  maxFileSize?: number;
}

/**
 * Control characters (C0, DEL, C1) that may never appear in a path the reader
 * hands out. A file name is repository-controlled text that reaches the model
 * unescaped inside the REPO_DATA wrapper — a name containing a newline forges an
 * extra entry in the line-per-file tree listing and in search results, the same
 * structure-forgery the marker escaping exists to prevent. Excluding such names
 * at the path gate covers every exit at once (tree, search, read-file,
 * package-info), since they all route through `isReadablePath`.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Path-level blacklist: control characters, excluded dirs, secrets, minified bundles. */
export function isPathExcluded(relPath: string): boolean {
  if (CONTROL_CHAR_RE.test(relPath)) {
    return true;
  }
  const normalized = toPosix(relPath);
  for (const segment of normalized.split("/")) {
    if ((EXCLUDED_DIR_NAMES as readonly string[]).includes(segment)) {
      return true;
    }
  }
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return SECRET_BASENAME_RE.test(base) || MINIFIED_RE.test(base);
}

/** Extension whitelist for text-like files. */
export function hasTextExtension(relPath: string): boolean {
  const base = toPosix(relPath)
    .slice(toPosix(relPath).lastIndexOf("/") + 1)
    .toLowerCase();
  if (EXACT_TEXT_FILES.has(base)) {
    return true;
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  return TEXT_EXTENSIONS.has(base.slice(dot + 1));
}

export function isWithinSizeLimit(
  size: number,
  maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
): boolean {
  return size <= maxFileSize;
}

const BINARY_PROBE_BYTES = 8192;

/** Binary probe: a NUL byte within the first 8 KiB marks a binary file. */
export function isBinaryContent(buf: Uint8Array): boolean {
  const probe = buf.subarray(0, BINARY_PROBE_BYTES);
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Path-level visibility check shared by tree traversal, search, and file
 * reads: not on the blacklist and has a text extension. Size and binary
 * content are checked separately (they need the file's bytes/size).
 */
export function isReadablePath(relPath: string): boolean {
  return !isPathExcluded(relPath) && hasTextExtension(relPath);
}

/** Full inclusion check for tree traversal (path + extension + size). */
export function isIncludedInTree(
  relPath: string,
  size: number,
  opts?: FileFilterOptions,
): boolean {
  if (!isReadablePath(relPath)) {
    return false;
  }
  return isWithinSizeLimit(size, opts?.maxFileSize);
}

function toPosix(relPath: string): string {
  return relPath.split(sep).join("/");
}
