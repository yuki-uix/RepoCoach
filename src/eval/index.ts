/**
 * Eval harness — public entry point.
 *
 * Exposes the runner, metric functions and report so tests (and future #25
 * tooling) can import them directly, while the CLI scripts drive the same code
 * through `pnpm eval:mock` / `pnpm eval:real`.
 */

export { runEvalSession } from "./runner.js";
export type { RunSessionOptions } from "./runner.js";

export {
  ASSESSMENT_LABELS,
  MODEL_ASSESSMENT_LABELS,
  adaptation,
  assessmentAgreement,
  DEFAULT_ADAPTATION_THRESHOLD,
  evidencePrecision,
  extractSymbolNames,
  hallucination,
  nextQuestionAfter,
  orderedPaths,
  pathAccuracy,
  questionJaccard,
  sessionCost,
} from "./metrics.js";
export type {
  AdaptationResult,
  AssessmentAgreementResult,
  AssessmentLabel,
  ConfusionMatrix,
  CostResult,
  HallucinationResult,
  ModelAssessmentLabel,
  PathAccuracyResult,
  PrecisionFailure,
  PrecisionResult,
} from "./metrics.js";

export { buildReport, renderReport, serializeReport, writeReport } from "./report.js";
export type { EvalMode, EvalReport, ReportMetrics } from "./report.js";

export { createMockEvalProvider, MockEvalProvider } from "./mock-provider.js";
export type { MockEvalConfig } from "./mock-provider.js";

export {
  INCORRECT_PREDICTION_ANSWER,
  loadAnswerSamples,
  loadCallChain,
} from "./fixtures.js";
export type { AnswerSample, CallChainStep } from "./fixtures.js";

export type { EvalEndPhase, EvalRun, EvalTurn } from "./types.js";
