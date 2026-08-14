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
 *
 * Every interpolated value in the render layer is untrusted by default — there
 * is deliberately no whitelist of "safe-looking" fields. A path comes from a
 * model tool argument, a repository id from a user-chosen directory name, a
 * workspace name from package metadata: each is exactly as controllable as a
 * feedback string, so a value like `src\n## forged` would otherwise break out
 * of its single-line slot and forge a column-0 heading. Flowing text
 * (question / feedback / reason) is neutralized per line; any value inserted
 * into a single-line position must instead go through `renderInline`, which
 * collapses newlines and strips control characters first so a single-line slot
 * can never receive a multi-line value.
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
 * Sanitize a value interpolated into a single-line position.
 *
 * A single-line slot (a `path`, a repository id, a workspace name, a session
 * id, a phase — anything rendered into one line of output) must never receive
 * a multi-line value: an embedded `\n` would let the next line sit at column 0
 * and forge a RepoCoach heading. Newlines collapse to a single space first (so
 * a marker split across lines is still caught), other control characters are
 * stripped, and the result is then neutralized like any other untrusted text.
 * Same idea as data-guard's sanitizeHeaderValue. Callers must route every
 * interpolated value through here — no whitelist of "safe-looking" fields.
 */
export function renderInline(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  const singleLine = text.replace(/[\r\n]+/g, " ");
  // Strip the remaining C0 controls and DEL (0x00–0x1f, 0x7f) without a
  // control-character regex (eslint no-control-regex): a hostile value could
  // otherwise smuggle an ANSI escape or a tab into a single-line slot.
  let stripped = "";
  for (const ch of singleLine) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      stripped += ch;
    }
  }
  return neutralizeMarkdown(stripped);
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
