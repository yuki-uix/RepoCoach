/**
 * Code-symbol recognition in prose.
 *
 * Extracts the identifiers that prose is *pointing at* (function / module /
 * file names) rather than every word that looks vaguely identifier-shaped.
 * Shared by the eval hallucination metric and the candidate-generation
 * grounding gate so both apply the same "code context" discipline (issue #27):
 * all-caps prose words, language names and product names are not symbols.
 */

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** A source-file path token like `src/types.ts` or `format.ts`. */
const FILE_NAME_RE = /([\w$./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))\b/g;

/** True for symbols that look like a file path (basename ends in a source ext). */
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

export { SOURCE_FILE_RE };

/**
 * Candidate symbol names from prose, restricted to tokens that carry a code
 * context rather than prose emphasis:
 *   - backtick-wrapped identifiers (`exportToCsv`)
 *   - call form `name(`
 *   - file paths like `src/types.ts`
 *   - camelCase / PascalCase / snake_case identifiers
 * plus any known symbol that appears whole-word (so lowercase known symbols
 * like `validate` / `add` are still recognised).
 *
 * All-caps prose words (PARSE, VALIDATE, AFTER) are excluded from the code
 * signals; CONST_NAME-shaped all-caps tokens (with an underscore) are kept and
 * left to the downstream existence check.
 */
export function extractSymbolNames(text: string, knownSymbols: string[] = []): string[] {
  const candidates = new Set<string>();
  const addCodeSignal = (token: string) => {
    if (!isAllCapsProse(token)) candidates.add(token);
  };

  // Backtick-wrapped identifiers.
  for (const match of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) {
    addCodeSignal(match[1]);
  }

  // Call form `name(`.
  for (const match of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)(?=\()/g)) {
    addCodeSignal(match[1]);
  }

  // File paths like `src/types.ts`.
  for (const match of text.matchAll(FILE_NAME_RE)) {
    addCodeSignal(match[1]);
  }

  // camelCase / PascalCase / snake_case identifiers.
  for (const match of text.matchAll(IDENTIFIER_RE)) {
    const token = match[0];
    if (isCodeLike(token)) addCodeSignal(token);
  }

  // Known symbols are authoritative even when lowercase ("validate", "add").
  for (const symbol of knownSymbols) {
    if (wordIn(symbol, text)) candidates.add(symbol);
  }

  return [...candidates];
}

/** A code-shaped identifier: snake_case, or camelCase/PascalCase with a hump. */
function isCodeLike(token: string): boolean {
  if (token.length < 3) return false;
  return token.includes("_") || /[A-Z]/.test(token.slice(1));
}

/** All-caps prose emphasis (AFTER, PARSE) — not a symbol unless CONST_NAME-shaped. */
function isAllCapsProse(token: string): boolean {
  return token.length >= 2 && token === token.toUpperCase() && !token.includes("_");
}

/** Whole-word membership: `\b` boundaries so `add` does not match `added`. */
export function wordIn(symbol: string, text: string): boolean {
  return new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text);
}

const REGEX_SPECIALS = new Set([
  ".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\",
]);

/** Escape a literal so it can be interpolated into a RegExp safely. */
export function escapeRegExp(text: string): string {
  let out = "";
  for (const char of text) {
    out += REGEX_SPECIALS.has(char) ? `\\${char}` : char;
  }
  return out;
}
