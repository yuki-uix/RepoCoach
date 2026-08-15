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
  adaptation,
  DEFAULT_ADAPTATION_THRESHOLD,
  evidencePrecision,
  extractSymbolNames,
  hallucination,
  nextQuestionAfter,
  orderedPaths,
  pathAccuracy,
  questionJaccard,
  repeatedReadCount,
  sessionCost,
} from "./metrics.js";
export type {
  AdaptationResult,
  CostResult,
  HallucinationResult,
  PathAccuracyResult,
  PrecisionFailure,
  PrecisionResult,
  ReadOccurrence,
} from "./metrics.js";

export { judgeSamples } from "./judge.js";
export { ASSESSMENT_LABELS, MODEL_ASSESSMENT_LABELS } from "./judge.js";
export type {
  AssessmentLabel,
  ConfusionMatrix,
  JudgeDisagreement,
  JudgeResult,
  JudgeSampleDetail,
  JudgeSamplesOptions,
  ModelAssessmentLabel,
} from "./judge.js";

export {
  abComparisonValidity,
  buildReport,
  renderAbComparison,
  renderReport,
  serializeReport,
  writeReport,
} from "./report.js";
export type { EvalMode, EvalReport, ReportMetrics } from "./report.js";

export { runAbEval, runEval } from "./cli.js";
export type { EvalCliOptions } from "./cli.js";

export { createMockEvalProvider, MockEvalProvider } from "./mock-provider.js";
export type { MockEvalConfig } from "./mock-provider.js";

export {
  INCORRECT_PREDICTION_ANSWER,
  loadAnswerSamples,
  loadCallChain,
} from "./fixtures.js";
export type { AnswerSample, CallChainStep } from "./fixtures.js";

export type { EvalEndPhase, EvalRun, EvalTurn } from "./types.js";
