/**
 * Property tests for the terminal-output gates: stripping terminal control
 * sequences and neutralizing a forged `#` heading must hold for *every* input,
 * and must never corrupt legitimate multibyte text.
 *
 *   ∀ text: stripTerminalControls(text) has no ESC / C1 / C0 (except \n), no DEL
 *   ∀ text: stripTerminalControls(text) preserves multibyte / printable text
 *   ∀ text: renderInline(text) is single-line, has no forged heading at column 0
 *
 * The invariants mirror exactly what stripTerminalControls / neutralizeMarkdown
 * guarantee (markdown.ts), so a regression in the shared gate fails here for
 * random inputs a fixed case would never have generated.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { renderInline, stripTerminalControls } from "../../src/cli";

/** True iff a code unit is "clean terminal output": \n, printable ASCII, or ≥ U+00A0. */
function isCleanCodeUnit(code: number): boolean {
  return code === 0x0a || (code >= 0x20 && code <= 0x7e) || code >= 0xa0;
}

function assertNoControls(text: string): void {
  for (let i = 0; i < text.length; i++) {
    expect(isCleanCodeUnit(text.charCodeAt(i))).toBe(true);
  }
}

describe("stripTerminalControls property", () => {
  it("leaves no ESC, C0 (except newline), C1 or DEL in the output", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 400 }), (text) => {
        assertNoControls(stripTerminalControls(text));
      }),
      { numRuns: 300 },
    );
  });

  it("preserves legitimate multibyte and printable text byte-for-byte", () => {
    const safeChar = fc.constantFrom(
      "中", "文", "🚀", "é", "ñ", "—", "a", "Z", "0", " ", "-", "_",
    );
    fc.assert(
      fc.property(fc.string({ unit: safeChar, maxLength: 120 }), (text) => {
        expect(stripTerminalControls(text)).toBe(text);
      }),
      { numRuns: 300 },
    );
  });
});

describe("renderInline property", () => {
  it("is single-line, control-free and never opens a heading at column 0", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        const out = renderInline(text);
        // Single-line: a single-line slot can never receive a multi-line value.
        expect(out).not.toContain("\n");
        expect(out).not.toContain("\r");
        // Control-free: no ESC / C1 / C0 survives into a terminal slot.
        assertNoControls(out);
        // No forged heading: `#{1,6}` followed by whitespace is the only thing
        // a terminal treats as a heading; `#no-space` and 7 hashes are inert.
        expect(out).not.toMatch(/^#{1,6}\s/);
      }),
      { numRuns: 300 },
    );
  });
});
