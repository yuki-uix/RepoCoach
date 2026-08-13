import { describe, expect, it } from "vitest";
import { agentDecisionSchema } from "../../src/domain";

describe("agentDecisionSchema", () => {
  it("rejects ask without a question", () => {
    const result = agentDecisionSchema.safeParse({
      evidence: [],
      nextAction: "ask",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ask with a whitespace-only question", () => {
    const result = agentDecisionSchema.safeParse({
      evidence: [],
      nextAction: "ask",
      question: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field such as phase", () => {
    const result = agentDecisionSchema.safeParse({
      evidence: [],
      nextAction: "show_evidence",
      phase: "trace",
    });
    expect(result.success).toBe(false);
  });

  it("accepts show_evidence without a question", () => {
    const result = agentDecisionSchema.safeParse({
      evidence: [],
      nextAction: "show_evidence",
    });
    expect(result.success).toBe(true);
  });
});
