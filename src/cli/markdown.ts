/**
 * Terminal rendering of untrusted text.
 *
 * RepoCoach's output channel is a terminal, not a markdown renderer. Model-
 * generated feedback/questions/descriptions and repo source are untrusted:
 * a hostile README's "## Exporting to CSV" (or a ``` fence) would otherwise
 * look identical to RepoCoach's own `## 功能调用链` section heading. This is
 * the same class of problem as data-guard's REPO_DATA_END escaping (untrusted
 * content forging an output channel's structure markers), only here the channel
 * is the terminal. See docs/architecture.md §6 "同一道闸覆盖所有出口".
 *
 * Neutralization is therefore terminal-first: flowing text that would open a
 * `#`-heading at column 0 gets a single leading space (invisible — no
 * backslash escapes), and multi-line source blocks are indented behind a fixed
 * `│ ` prefix and dimmed, so no untrusted line can ever sit at column 0 and be
 * mistaken for a RepoCoach heading. There is deliberately no markdown escaping
 * or code-fence wrapping — a ``` fence is inert text in a terminal.
 */

const ANSI_DIM = "\x1b[2m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_RESET = "\x1b[0m";

/** Fixed prefix every untrusted block line is indented behind. */
const BLOCK_PREFIX = "│ ";

export function dim(text: string): string {
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

export function bold(text: string): string {
  return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

/**
 * Neutralize `#` headings in untrusted flowing text so they cannot forge a
 * RepoCoach section heading. A single leading space is added before a hash run
 * at column 0 (rather than a backslash escape) — enough to knock it off the
 * top level without the `\#` noise. `##NoSpace` (no whitespace after the
 * hashes) and a seven-hash run are not headings and are left alone.
 */
export function neutralizeMarkdown(text: string): string {
  return text.replace(/^(#{1,6})(?=\s)/gm, (_match, hashes: string) => ` ${hashes}`);
}

/**
 * Render an untrusted multi-line source block indented behind `│ ` and dimmed.
 * Every line carries the prefix, so an internal `## …` heading or ``` fence
 * cannot sit at column 0 and be confused with RepoCoach's own output.
 */
export function renderUntrustedBlock(content: string): string {
  return dim(
    content
      .split("\n")
      .map((line) => `${BLOCK_PREFIX}${line}`)
      .join("\n"),
  );
}
