/**
 * Neutralize markdown structure in untrusted text before it is rendered.
 *
 * Model-generated feedback/questions/descriptions and repo source are untrusted:
 * they may carry `#` headings or ``` fences that would otherwise forge the
 * recap's own section structure — a hostile README's "## Exporting to CSV"
 * could render as a top-level heading indistinguishable from RepoCoach's own
 * `## 功能调用链`. This is the same class of problem as data-guard's
 * REPO_DATA_END escaping (untrusted content forging an output channel's
 * structure markers), only here the channel is the user-facing renderer.
 * See docs/architecture.md §6 "同一道闸覆盖所有出口".
 */

/**
 * Escape ATX headings (`#`…`######` at the start of a line) so untrusted text
 * cannot forge a top-level heading. Backslash-escaping each hash renders it as
 * literal text while preserving the original content. Up to three leading
 * spaces are allowed before the hashes, matching CommonMark (which treats a
 * four-space indent as a code block, not a heading); `##Foo` (no space after
 * the hashes) and a seven-hash run are left alone — they are not headings.
 */
export function escapeHeadings(text: string): string {
  return text.replace(
    /^([ \t]{0,3})(#{1,6})(?=\s)/gm,
    (_match, indent: string, hashes: string) => `${indent}${"\\#".repeat(hashes.length)}`,
  );
}

/**
 * Escape fenced-code delimiters (runs of three or more backticks) so untrusted
 * text cannot open or close a code fence. In flowing text the backslash-escaped
 * backticks render as literal backticks; inside a code block they prevent the
 * content from closing the fence early.
 */
export function escapeFences(text: string): string {
  return text.replace(/`{3,}/g, (run: string) => "\\`".repeat(run.length));
}

/**
 * Neutralize both heading and fence structure in untrusted *flowing* text —
 * model feedback, questions, descriptions, and evidence reasons. Every output
 * path that renders such text must call this (docs §6: one gate for all exits).
 */
export function neutralizeMarkdown(text: string): string {
  return escapeFences(escapeHeadings(text));
}

/**
 * Wrap untrusted source content in a fenced code block, escaping any internal
 * ``` first so the content cannot close the fence early and leak a forged
 * heading into the surrounding document.
 */
export function codeBlock(content: string): string {
  const fence = "```";
  return `${fence}\n${escapeFences(content)}\n${fence}`;
}
