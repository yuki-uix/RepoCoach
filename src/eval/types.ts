/**
 * Eval harness shared types.
 *
 * The eval harness (src/eval/) turns a scripted learning session into a
 * structured `EvalRun` that metric functions can score, so the manual "pipe
 * answers, run a real model, read logs, eyeball the numbers" loop becomes
 * repeatable. These types are the contract between the runner and the metrics
 * — they are data, not behaviour. See docs/architecture.md §7.
 */

import type {
  Assessment,
  Evidence,
  Phase,
  TokenUsage,
} from "../domain/index.js";

/** One recorded step of an eval session. */
export interface EvalTurn {
  phase: Phase;
  question: string;
  userAnswer?: string;
  assessment?: Assessment;
  feedback?: string;
  evidence: Evidence[];
  skipped?: boolean;
  decisionOverridden?: boolean;
}

/** The terminal phase an eval session reached. */
export type EvalEndPhase = "recap" | "error";

/** A complete, metric-ready eval session. */
export interface EvalRun {
  repositoryPath: string;
  featureId: string;
  featureGoal: string;
  turns: EvalTurn[];
  /** Closing decision's feedback (recap follow-ups + next steps). */
  finalFeedback: string;
  /** The rendered recap text (already terminal-sanitized). */
  recap: string;
  usage: TokenUsage;
  wallClockMs: number;
  /** True when the session was salvaged after the agent failed to decide. */
  degraded: boolean;
  endedPhase: EvalEndPhase;
}
