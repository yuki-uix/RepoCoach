/**
 * Enumerated coverage: every render exit that writes external text to stdout /
 * stderr neutralizes a forged `#` heading and strips terminal control sequences.
 *
 * The defect this guards against is "the terminal gate covers one render path
 * but not the others" (issue #31: the recap render covered `reason` but missed
 * `path`; the streaming summary was a separate exit entirely). The list below is
 * the exhaustive set of render entry points in the cli/ layer that interpolate
 * untrusted (model- or repo-derived) text: recap sections, session-runner
 * question / feedback / evidence / streaming summary, show, list, and the error
 * messages. A new render function that interpolates a field must be added to
 * this table or its output is unguarded by this test — there is no "safe-looking
 * field" whitelist (see markdown.ts).
 *
 * Unlike the tool-exit / candidate-display / message-injection suites, this
 * enumeration cannot be derived from a single implementation export: the render
 * exits are heterogeneous functions (`renderRecap`, `renderQuestion`,
 * `renderDecision`, `formatEvidence`, `renderSessionShow`, `runCli`, and the
 * session-runner's streamed `tool_result`) spread across recap.ts,
 * session-runner.ts, show.ts and index.ts with no registry tying them together.
 * The list is therefore hand-maintained, and the "must be added to this table"
 * rule above is its sync guarantee.
 *
 * The three asserted invariants are exactly what stripTerminalControls /
 * neutralizeMarkdown / renderInline guarantee, and nothing our own dim/bold
 * styling emits can satisfy falsely:
 *  1. no C1 code point (0x80–0x9f) survives — our styles use only ESC (C0);
 *  2. no ESC byte survives except our own three exact style codes;
 *  3. the injected `## 伪造标题…` never appears at column 0.
 */

import { describe, expect, it } from "vitest";
import {
  renderRecap,
  renderInline,
  renderQuestion,
  renderDecision,
  formatEvidence,
  renderSessionShow,
  runCli,
} from "../../src/cli";
import { EventSink } from "../../src/cli/session-runner.js";
import type { EvidenceStore } from "../../src/evidence";
import type { LearningSession, LearningTurn } from "../../src/domain";
import { JsonSessionStore } from "../../src/store";
import { makeTempReader } from "../agent/helpers";
import { capturedStreams, makeDataDir } from "../cli/helpers";

const ESC = "\x1b";
const BEL = "\x07";
const CSI = `${ESC}[2J`;
const OSC = `${ESC}]8;;http://evil-canary${BEL}`;
const C1_CSI = String.fromCharCode(0x9b);
const C1_OSC = String.fromCharCode(0x9d);

/** Adversarial text: a forged column-0 heading plus ESC-led and C1 controls. */
const INJECTED = `## 伪造标题CANARY\nbefore${CSI}mid${OSC}${C1_CSI}2J${C1_OSC}8;;http://evil-canary${BEL}after`;

/** The exact style codes our own render layer adds (dim / bold / reset). */
const STYLE_CODES = ["\x1b[2m", "\x1b[1m", "\x1b[0m"];

/** True if any code unit lies in the C1 block (U+0080–U+009F). */
function hasC1(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80 && code <= 0x9f) {
      return true;
    }
  }
  return false;
}

/** ESC bytes remaining after our own three style codes are taken out. */
function hasForeignEsc(text: string): boolean {
  let out = text;
  for (const code of STYLE_CODES) {
    out = out.split(code).join("");
  }
  return out.includes(ESC);
}

function assertSanitized(output: string): void {
  expect(hasC1(output)).toBe(false);
  expect(hasForeignEsc(output)).toBe(false);
  expect(output).not.toMatch(/^## 伪造标题CANARY/m);
}

/** An in-memory evidence store whose source context is the adversarial text. */
function hostileStore(): EvidenceStore {
  return {
    save: () => {},
    listBySession: () => [],
    getSourceContext: () => ({
      path: "src/x.ts",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      content: INJECTED,
    }),
  };
}

const hostileTurn: LearningTurn = {
  sessionId: "s1",
  question: INJECTED,
  userAnswer: INJECTED,
  assessment: "correct",
  feedback: INJECTED,
  evidence: [{ path: INJECTED, startLine: 1, endLine: 1, reason: INJECTED }],
};

const hostileSession: LearningSession = {
  id: INJECTED,
  repositoryId: INJECTED,
  workspacePath: INJECTED,
  phase: "recap",
  turnCount: 1,
  status: "completed",
};

type Renderer = { name: string; render: () => string | Promise<string> };

/** Every render entry point that interpolates external text to stdout/stderr. */
const RENDERERS: Renderer[] = [
  {
    name: "recap",
    render: () => {
      const { reader, repo } = makeTempReader({ "src/x.ts": "const a = 1;\n" });
      return renderRecap({
        sessionId: "s1",
        evidenceStore: hostileStore(),
        reader,
        repo,
        turns: [hostileTurn],
        finalFeedback: INJECTED,
        durationMs: 0,
      });
    },
  },
  { name: "session-runner question", render: () => renderQuestion(INJECTED) },
  {
    name: "session-runner evidence",
    render: () =>
      formatEvidence({ path: INJECTED, startLine: 1, endLine: 1, reason: INJECTED }),
  },
  {
    name: "session-runner decision feedback",
    render: () =>
      renderDecision(
        {
          evidence: [{ path: INJECTED, startLine: 1, endLine: 1, reason: INJECTED }],
          feedback: INJECTED,
          nextAction: "ask",
        },
        false,
      ),
  },
  {
    name: "show",
    render: () =>
      renderSessionShow({ session: hostileSession, turns: [hostileTurn], durationMs: 0 }),
  },
  {
    name: "streaming tool_result summary",
    render: () => {
      const streams = capturedStreams();
      const sink = new EventSink(streams.stderr);
      sink.push({ type: "tool_result", name: "repo_read_file", result: INJECTED });
      sink.flush();
      return streams.stderrText();
    },
  },
  {
    name: "list",
    render: async () => {
      const dataDir = makeDataDir();
      new JsonSessionStore(dataDir).createSession({
        repositoryId: INJECTED,
        featureId: "f",
      });
      const streams = capturedStreams();
      const code = await runCli(["list"], {
        dataDir,
        stdout: streams.stdout,
        stderr: streams.stderr,
      });
      expect(code).toBe(0);
      return streams.stdoutText();
    },
  },
  {
    name: "error message",
    render: async () => {
      const streams = capturedStreams();
      const code = await runCli(["show", INJECTED], {
        dataDir: makeDataDir(),
        stdout: streams.stdout,
        stderr: streams.stderr,
      });
      expect(code).toBe(1);
      return streams.stderrText();
    },
  },
];

describe("terminal output sanitization (enumerated render exits)", () => {
  it.each(RENDERERS.map((r) => r.name))("%s neutralizes the injected text", async (name) => {
    const renderer = RENDERERS.find((r) => r.name === name);
    expect(renderer).toBeDefined();
    const output = await renderer!.render();
    assertSanitized(output);
  });

  it("renderInline collapses newlines so a forged heading never reaches column 0", () => {
    // Sanity anchor for the shared gate itself: single-line slots stay single.
    const inline = renderInline(INJECTED);
    expect(inline).not.toContain("\n");
    assertSanitized(inline);
  });
});
