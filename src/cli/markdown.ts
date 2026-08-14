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
 * A terminal is also an output channel that *interprets* control sequences: an
 * ESC byte followed by `[` (CSI), `]` (OSC) or any other character is a cursor
 * / clear-screen / hyperlink command that hostile repo source or a model string
 * could smuggle in (`ESC[2J` clears the screen, `ESC]8;;…` opens a hyperlink).
 * Every byte written to the terminal therefore flows through
 * `stripTerminalControls` first: it removes whole ESC-led sequences plus the
 * remaining C0 controls, the C1 block (0x80–0x9f) and DEL, keeping only `\n`
 * (multi-line blocks need it) and folding `\t` to a space. Untrusted text is
 * stripped *before* any of our own dim/bold styles are applied, so our styles
 * survive while injected sequences do not.
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
 * Strip terminal control sequences from untrusted text.
 *
 * The terminal interprets ESC-led sequences (CSI `ESC[`, OSC `ESC]`, and the
 * single-character `ESC` forms) as cursor / clear / hyperlink commands, so a
 * hostile string must not be able to smuggle one through. This removes each
 * whole ESC-led sequence, then drops every remaining C0 control, the C1 block
 * (0x80–0x9f, whose 8-bit CSI/OSC forms a C1-capable terminal would execute
 * without any ESC), and DEL, while preserving `\n` (multi-line blocks need line
 * breaks) and folding `\t` to a single space so a tab cannot derail a
 * fixed-width indent. Implemented as a character loop rather than a
 * control-character regex (eslint no-control-regex). Every untrusted string
 * bound for stdout/stderr must pass through here before any of our own dim/bold
 * styles are applied.
 */
export function stripTerminalControls(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      // ESC begins a control sequence — consume it (and the sequence) whole.
      i += 1;
      if (i >= text.length) {
        break;
      }
      const next = text.charCodeAt(i);
      if (next === 0x5b) {
        // CSI: ESC [ parameter/intermediate bytes … final byte 0x40–0x7e.
        i += 1;
        while (i < text.length) {
          const c = text.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) {
            break;
          }
          i += 1;
        }
        if (i < text.length) {
          i += 1; // consume the final byte
        }
      } else if (next === 0x5d) {
        // OSC: ESC ] … terminated by BEL (0x07) or ST (ESC \).
        i += 1;
        while (i < text.length) {
          const c = text.charCodeAt(i);
          if (c === 0x07) {
            i += 1; // consume the BEL terminator
            break;
          }
          if (c === 0x1b && i + 1 < text.length && text.charCodeAt(i + 1) === 0x5c) {
            i += 2; // consume the ST (ESC \) terminator
            break;
          }
          i += 1;
        }
      } else if (next >= 0x20 && next <= 0x2f) {
        // ESC + intermediate byte(s) … final byte 0x30–0x7e (e.g. ESC ( B).
        i += 1;
        while (i < text.length) {
          const c = text.charCodeAt(i);
          if (c >= 0x30 && c <= 0x7e) {
            break;
          }
          i += 1;
        }
        if (i < text.length) {
          i += 1; // consume the final byte
        }
      } else {
        // ESC + a single trailing character (e.g. ESC 7, ESC 8, ESC c).
        i += 1;
      }
      continue;
    }
    if (code === 0x0a) {
      out += "\n";
    } else if (code === 0x09) {
      out += " ";
    } else if ((code >= 0x20 && code <= 0x7e) || code >= 0xa0) {
      out += text[i]!;
    }
    // Everything else is dropped: remaining C0 controls (< 0x20), DEL (0x7f),
    // and the whole C1 block (0x80–0x9f). C1 includes the 8-bit CSI (0x9b) and
    // OSC (0x9d) forms, which a C1-capable terminal would still execute even
    // without an ESC prefix. We strip the entire range rather than parsing
    // 8-bit CSI/OSC parameters: any leftover parameter text ("2J",
    // "8;;http://evil") is inert once its C1 introducer is gone — it is plain
    // printable ASCII that can no longer clear the screen or open a hyperlink —
    // and dropping the range wholesale is simpler and covers every C1 control
    // (NEL 0x85, DCS 0x90, etc.), not just the two sequence leaders.
    i += 1;
  }
  return out;
}

/**
 * Neutralize untrusted flowing text before it reaches the terminal.
 *
 * `stripTerminalControls` first removes any ESC-led control sequence and the
 * remaining C0 controls / DEL, keeping `\n` so multi-line flowing text survives
 * and folding `\t` to a space. Then a single leading space is added before a
 * hash run at column 0 (rather than a backslash escape) — enough to knock it
 * off the top level without the `\#` noise. `##NoSpace` (no whitespace after
 * the hashes) and a seven-hash run are not headings and are left alone.
 */
export function neutralizeMarkdown(text: string): string {
  return stripTerminalControls(text).replace(
    /^(#{1,6})(?=\s)/gm,
    (_match, hashes: string) => ` ${hashes}`,
  );
}

/**
 * Sanitize a value interpolated into a single-line position.
 *
 * A single-line slot (a `path`, a repository id, a workspace name, a session
 * id, a phase — anything rendered into one line of output) must never receive
 * a multi-line value: an embedded `\n` would let the next line sit at column 0
 * and forge a RepoCoach heading. Newlines collapse to a single space first (so
 * a marker split across lines is still caught), then the value shares the same
 * terminal-control stripping + heading neutralization gate as flowing text.
 * Same idea as data-guard's sanitizeHeaderValue. Callers must route every
 * interpolated value through here — no whitelist of "safe-looking" fields.
 */
export function renderInline(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  const singleLine = text.replace(/[\r\n]+/g, " ");
  return neutralizeMarkdown(singleLine);
}

/**
 * Render an untrusted multi-line source block indented behind `│ ` and dimmed.
 * Terminal control sequences are stripped first (before the dim style is
 * applied), then every line carries the prefix, so an internal `## …` heading
 * or ``` fence cannot sit at column 0 and be confused with RepoCoach's own
 * output.
 */
export function renderUntrustedBlock(content: string): string {
  return dim(
    stripTerminalControls(content)
      .split("\n")
      .map((line) => `${BLOCK_PREFIX}${line}`)
      .join("\n"),
  );
}
