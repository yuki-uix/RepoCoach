/**
 * Lenient JSON parsing for model-supplied tool arguments.
 *
 * Models occasionally emit near-valid JSON for tool calls: invalid escapes
 * (`\x`, a backslash before a regex metacharacter, a stray `\ `), raw newlines
 * inside strings, or trailing commas. The wire format is a JSON string, so
 * `JSON.parse` rejects these outright. We parse strictly first; only on failure
 * do we attempt a *conservative* repair and re-parse, and only when the repair
 * is structurally sound (no unterminated string, no trailing backslash) do we
 * accept the result.
 *
 * This is input sanitisation, not a data-path gate: the repaired value still
 * flows through the same zod schemas as any other tool argument (see
 * docs/architecture.md §6).
 */

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "syntax"; message: string };

/** Characters that may legally follow a backslash inside a JSON string. */
const VALID_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * Parse a JSON string leniently: strict first, then one conservative repair +
 * re-parse. Returns a targeted syntax error (with a position where available)
 * when neither succeeds, so the model can self-correct.
 */
export function parseJsonLenient(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const repaired = repairJson(text);
    if (repaired !== null) {
      try {
        return { ok: true, value: JSON.parse(repaired) };
      } catch (repairedError) {
        return { ok: false, reason: "syntax", message: describeJsonSyntaxError(repairedError) };
      }
    }
    return { ok: false, reason: "syntax", message: describeJsonSyntaxError(error) };
  }
}

/**
 * Repair the common near-miss JSON shapes a model produces. Returns the
 * repaired text, or `null` when the input has structural damage (an
 * unterminated string or a trailing lone backslash) we will not guess at.
 *
 * Repairs applied, all inside a string-aware scan so quoted content is never
 * mistaken for structure:
 *   - invalid escape sequences (`\` + non-escape char) → escape the backslash;
 *   - raw newline / carriage-return / tab / control chars → their JSON escapes;
 *   - trailing commas before `}` or `]` → dropped.
 */
export function repairJson(text: string): string | null {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        if (VALID_ESCAPE.has(ch)) {
          out += `\\${ch}`;
        } else {
          // Invalid escape: double the backslash so the character is literal.
          out += `\\\\${ch}`;
        }
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else if (ch.charCodeAt(0) < 0x20) {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
        out += ch;
      } else {
        out += ch;
      }
    }
  }

  // Structural damage: an open string or a dangling backslash.
  if (inString || escaped) {
    return null;
  }

  return removeTrailingCommas(out);
}

/** Drop commas immediately before a closing `}` or `]`, string-aware. */
function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === "\\") {
        escaped = true;
        out += ch;
      } else {
        if (ch === '"') {
          inString = false;
        }
        out += ch;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && isWhitespace(text[j]!)) {
        j += 1;
      }
      if (text[j] === "}" || text[j] === "]") {
        continue; // trailing comma — drop it
      }
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Extract the byte/character position from a JSON.parse SyntaxError message
 * ("Bad escaped character in JSON at position 42") and render a targeted,
 * actionable message for the model.
 */
export function describeJsonSyntaxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const position = /at position (\d+)/.exec(message)?.[1];
  if (position !== undefined) {
    return `invalid JSON near position ${position} (${message})`;
  }
  return `invalid JSON (${message})`;
}

/**
 * Unwrap a single-layer wrapper key the model sometimes adds around tool
 * arguments: `{"arguments": {...}}`, `{"input": {...}}` or
 * `{"parameters": {...}}`. Only unwraps when that key is the *only* key and
 * its value is a plain object, so a legitimate single-field payload is never
 * confused with a wrapper.
 */
export function unwrapToolArguments(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return value;
  }
  const key = keys[0]!;
  if (key !== "arguments" && key !== "input" && key !== "parameters") {
    return value;
  }
  const inner = (value as Record<string, unknown>)[key];
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return inner;
  }
  return value;
}
