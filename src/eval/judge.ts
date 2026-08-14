/**
 * Judge mode — measure the assessment function in isolation from question
 * generation.
 *
 * The live session cannot score assessment agreement: it pairs a model
 * assessment with an annotation by learner-answer text, but the live session
 * grades the model's OWN generated questions. The same scripted answer can be
 * fed to several different model questions, so the comparison is
 * "model judged [its question + answer] vs annotation for [another question +
 * same answer]" — invalid. Agreement is a property of the judging function, so
 * it is measured here: for every annotated sample the model is handed the fixed
 * (question, userAnswer) verbatim, can retrieve evidence through the ordinary
 * read-only tools, and must produce only an assessment, which is compared to
 * the annotation. See docs/architecture.md §7.
 */

import { performance } from "node:perf_hooks";
import { AgentLoop } from "../agent/index.js";
import type { ChatProvider } from "../agent/provider.js";
import type { Assessment, Evidence, TokenUsage } from "../domain/index.js";
import type { Repository, Reader } from "../reader/index.js";
import type { AnswerSample } from "./fixtures.js";

/** Annotation labels from `answer-samples.json` (rows of the confusion matrix). */
export const ASSESSMENT_LABELS = ["correct", "partial", "incorrect"] as const;
export type AssessmentLabel = (typeof ASSESSMENT_LABELS)[number];

/** Model assessment labels (columns of the confusion matrix). */
export const MODEL_ASSESSMENT_LABELS = ["correct", "partial", "incorrect", "unknown"] as const;
export type ModelAssessmentLabel = (typeof MODEL_ASSESSMENT_LABELS)[number];

/** Annotation (row) × model assessment (column) counts. */
export type ConfusionMatrix = Record<string, Record<string, number>>;

/**
 * One disagreement. Both questions are shown even though judge mode passes the
 * annotated question verbatim, so they are identical by construction — the dual
 * field is the guard against re-introducing the answer-text pairing bug where a
 * disagreement silently compared the annotation for a *different* question than
 * the model actually saw.
 */
export interface JudgeDisagreement {
  /** The pre-authored question the annotation was written for. */
  annotatedQuestion: string;
  /** The question the model was actually handed (== annotatedQuestion here). */
  modelQuestion: string;
  answer: string;
  expected: string;
  actual: string;
}

/** One judged sample, kept verbatim for post-hoc diagnosis. */
export interface JudgeSampleDetail {
  annotatedQuestion: string;
  modelQuestion: string;
  answer: string;
  expected: Assessment;
  actual: Assessment;
  agreed: boolean;
  evidence: Evidence[];
  usage: TokenUsage;
  wallClockMs: number;
}

export interface JudgeResult {
  total: number;
  agreed: number;
  /** `agreed / total`; `undefined` when there are no samples to judge. */
  agreement?: number;
  evaluable: boolean;
  disagreements: JudgeDisagreement[];
  confusion: ConfusionMatrix;
  /** Per-sample detail in sample order, for the report JSON. */
  samples: JudgeSampleDetail[];
  usage: TokenUsage;
  wallClockMs: number;
}

export interface JudgeSamplesOptions {
  provider: ChatProvider;
  reader: Reader;
  repo: Repository;
  featureGoal: string;
  samples: AnswerSample[];
  model?: string;
}

/**
 * Judge every sample once through the REAL agent loop (same system prompt and
 * rubric, same read-only tools), in the `trace` phase that grades answers. The
 * annotated question and answer are placed in a synthetic prior turn so the
 * model sees exactly the question the annotation was written for — the loop
 * never gets to generate its own question here.
 */
export async function judgeSamples(options: JudgeSamplesOptions): Promise<JudgeResult> {
  const { provider, reader, repo, featureGoal, samples } = options;
  const loop = new AgentLoop({ provider, reader, repo, model: options.model });

  const details: JudgeSampleDetail[] = [];
  const disagreements: JudgeDisagreement[] = [];
  const confusion = emptyConfusion();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let agreed = 0;
  const startedAt = performance.now();

  for (const sample of samples) {
    const sampleStartedAt = performance.now();
    const expected = sample.expectedAssessment;
    let actual: Assessment = "unknown";
    let evidence: Evidence[] = [];
    let sampleUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    try {
      const result = await loop.invoke({
        phase: "trace",
        featureGoal,
        turnHistory: [
          {
            sessionId: "judge",
            question: sample.question,
            userAnswer: sample.userAnswer,
            evidence: [],
          },
        ],
      });
      actual = result.decision.assessment ?? "unknown";
      evidence = result.decision.evidence;
      sampleUsage = result.usage;
    } catch {
      // A judging call that never produced a valid decision is itself a real
      // disagreement: `actual` stays at its initialized "unknown".
    }

    usage.inputTokens += sampleUsage.inputTokens;
    usage.outputTokens += sampleUsage.outputTokens;
    const wallClockMs = Math.round(performance.now() - sampleStartedAt);
    const agreedNow = actual === expected;
    confusion[expected][actual] += 1;
    if (agreedNow) {
      agreed += 1;
    } else {
      disagreements.push({
        annotatedQuestion: sample.question,
        modelQuestion: sample.question,
        answer: sample.userAnswer,
        expected,
        actual,
      });
    }
    details.push({
      annotatedQuestion: sample.question,
      modelQuestion: sample.question,
      answer: sample.userAnswer,
      expected,
      actual,
      agreed: agreedNow,
      evidence,
      usage: sampleUsage,
      wallClockMs,
    });
  }

  const total = samples.length;
  return {
    total,
    agreed,
    agreement: total === 0 ? undefined : agreed / total,
    evaluable: total > 0,
    disagreements,
    confusion,
    samples: details,
    usage,
    wallClockMs: Math.round(performance.now() - startedAt),
  };
}

/** A confusion matrix pre-filled with zeros for every annotation × model cell. */
function emptyConfusion(): ConfusionMatrix {
  const table: ConfusionMatrix = {};
  for (const label of ASSESSMENT_LABELS) {
    table[label] = {};
    for (const modelLabel of MODEL_ASSESSMENT_LABELS) {
      table[label][modelLabel] = 0;
    }
  }
  return table;
}
