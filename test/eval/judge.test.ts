import { describe, expect, it } from "vitest";
import type { ChatProvider } from "../../src/agent/provider.js";
import type { AnswerSample } from "../../src/eval/fixtures.js";
import { judgeSamples } from "../../src/eval/judge.js";
import { makeTempRepo } from "./helpers";

const SAMPLES: AnswerSample[] = [
  { question: "q1", userAnswer: "a1", expectedAssessment: "correct", rationale: "" },
  { question: "q2", userAnswer: "a2", expectedAssessment: "incorrect", rationale: "" },
  { question: "q3", userAnswer: "a3", expectedAssessment: "partial", rationale: "" },
];

/** A judge provider that submits a fixed assessment, cycling the given list. */
function fixedAssessmentProvider(assessments: string[]): ChatProvider {
  let callIndex = 0;
  return {
    async complete() {
      const assessment = assessments[callIndex % assessments.length]!;
      callIndex += 1;
      return {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "decision",
              name: "submit_decision",
              arguments: JSON.stringify({ evidence: [], assessment, nextAction: "finish" }),
            },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

describe("judgeSamples", () => {
  it("scores agreement and builds the annotation × model confusion matrix", async () => {
    const { reader, repo } = makeTempRepo({});

    const result = await judgeSamples({
      provider: fixedAssessmentProvider(["correct", "incorrect", "unknown"]),
      reader,
      repo,
      featureGoal: "goal",
      samples: SAMPLES,
    });

    expect(result.total).toBe(3);
    expect(result.agreed).toBe(2);
    expect(result.agreement).toBe(2 / 3);
    expect(result.confusion.correct.correct).toBe(1);
    expect(result.confusion.incorrect.incorrect).toBe(1);
    expect(result.confusion.partial.unknown).toBe(1);
    expect(result.confusion.partial.partial).toBe(0);
    expect(result.disagreements).toHaveLength(1);
    expect(result.samples).toHaveLength(3);
    expect(result.samples[0]?.agreed).toBe(true);
    expect(result.samples[2]?.agreed).toBe(false);
  });

  it("records the annotated and model-seen questions (identical by construction)", async () => {
    const { reader, repo } = makeTempRepo({});

    const result = await judgeSamples({
      provider: fixedAssessmentProvider(["partial"]),
      reader,
      repo,
      featureGoal: "goal",
      samples: SAMPLES,
    });

    const disagreement = result.disagreements[0]!;
    expect(disagreement.annotatedQuestion).toBe("q1");
    expect(disagreement.modelQuestion).toBe("q1");
    expect(disagreement.answer).toBe("a1");
    expect(disagreement.expected).toBe("correct");
    expect(disagreement.actual).toBe("partial");
  });

  it("counts a judge call that fails to decide as an 'unknown' disagreement", async () => {
    const { reader, repo } = makeTempRepo({});
    const provider: ChatProvider = {
      async complete() {
        // Plain text, never a valid submit_decision → the loop throws.
        return { message: { role: "assistant", content: "just words" }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await judgeSamples({
      provider,
      reader,
      repo,
      featureGoal: "goal",
      samples: SAMPLES,
    });

    expect(result.total).toBe(3);
    expect(result.agreed).toBe(0);
    expect(result.agreement).toBe(0);
    expect(result.confusion.correct.unknown).toBe(1);
    expect(result.confusion.incorrect.unknown).toBe(1);
    expect(result.confusion.partial.unknown).toBe(1);
  });
});
