/**
 * Eval fixture loading — the pre-authored expectations in
 * `fixtures/expectations/` that the harness scores against.
 *
 * `call-chain.json` is the ground-truth call chain (paths + symbol names);
 * `answer-samples.json` is the annotated learner answers used to score
 * assessment agreement and adaptation. Both are human-authored data from #2,
 * re-validated through zod before anything trusts them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const callChainStepSchema = z.object({
  step: z.string(),
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  symbol: z.string(),
});
export type CallChainStep = z.infer<typeof callChainStepSchema>;

export const answerSampleSchema = z.object({
  question: z.string(),
  userAnswer: z.string(),
  expectedAssessment: z.enum(["correct", "partial", "incorrect"]),
  rationale: z.string(),
});
export type AnswerSample = z.infer<typeof answerSampleSchema>;

/**
 * The scripted WRONG answer to the fixture's prediction question, used for the
 * adaptation measurement (same question, correct vs incorrect answer). It is
 * deliberately fabricated — it invents a CSV export that the source never
 * implements (the fixture's planted wrong path).
 */
export const INCORRECT_PREDICTION_ANSWER =
  "createTracker parses the string and then writes it straight to a CSV file without validating or storing it.";

/** Read + validate `fixtures/expectations/call-chain.json`. */
export function loadCallChain(repoRoot: string): CallChainStep[] {
  return readFixture(repoRoot, "call-chain.json", z.array(callChainStepSchema));
}

/** Read + validate `fixtures/expectations/answer-samples.json`. */
export function loadAnswerSamples(repoRoot: string): AnswerSample[] {
  return readFixture(repoRoot, "answer-samples.json", z.array(answerSampleSchema));
}

function readFixture<T>(
  repoRoot: string,
  filename: string,
  schema: z.ZodType<T>,
): T {
  const path = join(repoRoot, "fixtures", "expectations", filename);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Missing eval fixture ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return schema.parse(parsed);
}
