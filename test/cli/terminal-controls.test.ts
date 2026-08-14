import { describe, expect, it } from "vitest";
import {
  formatEvidence,
  renderQuestion,
  renderUntrustedBlock,
  stripTerminalControls,
} from "../../src/cli";
import { EventSink } from "../../src/cli/session-runner.js";
import { capturedStreams } from "./helpers";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Count ESC bytes without a control-character regex (eslint no-control-regex). */
function escCount(text: string): number {
  return text.split(ESC).length - 1;
}

describe("stripTerminalControls", () => {
  it("removes CSI, OSC (BEL- and ST-terminated), bare ESC, and ESC + single char", () => {
    expect(stripTerminalControls(`${ESC}[2Jok`)).toBe("ok");
    expect(stripTerminalControls(`${ESC}[31mred${ESC}[0mplain`)).toBe("redplain");
    expect(stripTerminalControls(`${ESC}]8;;http://evil${BEL}link`)).toBe("link");
    expect(stripTerminalControls(`${ESC}]8;;http://evil${ESC}\\link`)).toBe("link");
    expect(stripTerminalControls(`bare${ESC}`)).toBe("bare");
    expect(stripTerminalControls(`${ESC}7saved`)).toBe("saved");
  });

  it("preserves newlines and folds tabs to a single space", () => {
    expect(stripTerminalControls("a\nb")).toBe("a\nb");
    expect(stripTerminalControls("a\tb")).toBe("a b");
  });

  it("strips the remaining C0 controls and DEL", () => {
    expect(stripTerminalControls(`a${String.fromCharCode(1)}b${String.fromCharCode(127)}c`)).toBe(
      "abc",
    );
  });
});

describe("renderUntrustedBlock terminal control stripping", () => {
  it("removes injected CSI/OSC/bare ESC but keeps our own dim wrapper", () => {
    const out = renderUntrustedBlock(
      `clean${ESC}[2Jmid${ESC}]8;;http://evil${BEL}tail${ESC}`,
    );
    expect(out).toContain("\x1b[2m"); // our dim style survives
    expect(out).toContain("\x1b[0m");
    expect(out).toContain("│ cleanmidtail");
    expect(out).not.toContain("http://evil");
    expect(out).not.toContain("[2J");
    // Exactly the two ESC bytes our dim wrapper contributes remain.
    expect(escCount(out)).toBe(2);
  });

  it("keeps multi-line newlines and the indent prefix intact", () => {
    const out = renderUntrustedBlock(`line1\nline2\tindented\n${ESC}[2Jline3`);
    expect(out).toContain("│ line1");
    expect(out).toContain("│ line2 indented"); // tab folded, prefix retained
    expect(out).toContain("│ line3");
    expect(out).toContain("\n│ ");
    expect(escCount(out)).toBe(2);
  });
});

describe("flowing-text terminal control stripping", () => {
  it("strips an injected CSI from the question while keeping the bold style", () => {
    const out = renderQuestion(`${ESC}[2JWhich module?`);
    expect(out).toContain("\x1b[1m"); // our bold style survives
    expect(out).toContain("Which module?");
    expect(out).not.toContain("[2J");
    // dim rule (2) + bold question (2) = 4 ESC bytes, none from the input.
    expect(escCount(out)).toBe(4);
  });

  it("strips an injected OSC from an evidence reason/path", () => {
    const out = formatEvidence({
      path: `src/${ESC}[2Ja.ts`,
      startLine: 1,
      endLine: 2,
      reason: `forged${ESC}]8;;http://evil${BEL}`,
    });
    expect(out).toBe("src/a.ts:1-2 — forged");
    expect(escCount(out)).toBe(0);
  });

  it("strips injected sequences from the streaming tool_result summary", () => {
    const streams = capturedStreams();
    const sink = new EventSink(streams.stderr);
    sink.push({
      type: "tool_result",
      name: "repo_read_file",
      result: `${ESC}[2Jcleared${ESC}]8;;http://evil${BEL}src/index.ts`,
    });
    sink.flush();

    const err = streams.stderrText();
    expect(err).toContain("clearedsrc/index.ts");
    expect(err).not.toContain("http://evil");
    expect(err).not.toContain("[2J");
    expect(escCount(err)).toBe(2); // only the dim wrapper's two ESC bytes
  });
});
