import { describe, expect, it } from "vitest";
import {
  renderDecision,
  renderEvidenceBlock,
  renderQuestion,
} from "../../src/cli";
import type { AgentDecision, Evidence } from "../../src/domain";

const EVIDENCE: Evidence[] = [
  { path: "src/index.ts", startLine: 25, endLine: 43, reason: "wires the chain" },
  { path: "src/parse/task.ts", startLine: 22, endLine: 49, reason: "splits the string" },
];

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return { evidence: EVIDENCE, nextAction: "ask", ...overrides };
}

describe("CLI turn rendering", () => {
  it("renders a question after the evidence, with a separator", () => {
    const question = "Which module assigns the id?";
    const evidenceText = renderEvidenceBlock(EVIDENCE);
    const questionText = renderQuestion(question);
    const turn = renderDecision(decision({ question }), false) + questionText;

    expect(turn).toContain("src/index.ts:25-43 — wires the chain");
    expect(turn).toContain(question);
    // The question must appear after the evidence and carry a separator rule.
    expect(turn.indexOf("src/index.ts")).toBeLessThan(turn.indexOf(question));
    expect(questionText).toContain("─".repeat(60));
    // Evidence is grouped and dimmed (ANSI 2m = dim).
    expect(evidenceText).toContain("\x1b[2m");
    expect(evidenceText).toContain("├─");
    expect(evidenceText).toContain("└─");
  });

  it("skips the question for a terminal decision", () => {
    const final = decision({ question: "irrelevant?", nextAction: "finish" });
    expect(renderDecision(final, true)).not.toContain("irrelevant?");
  });

  it("renders nothing for a null decision", () => {
    expect(renderDecision(null, false)).toBe("");
  });
});
