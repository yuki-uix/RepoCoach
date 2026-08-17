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

/**
 * One outgoing provider call's payload figures, from the `provider_request`
 * event (#36). A raw measurement, not a score: the runner records these while
 * the loop runs and never alters them, so the bench summary can recompute any
 * statistic (peak, sum, spread) from the same values it would lose otherwise.
 */
export interface ProviderRequestRecord {
  round: number;
  messageCount: number;
  /** Full outgoing message payload, in bytes. */
  bytes: number;
  /** Bytes of the `role: "tool"` slice (all tool results, incl. receipts). */
  toolResultBytes: number;
  /** Bytes of the window-eligible repo-data subset (the `COMPRESSIBLE_TOOLS` set). */
  compressibleBytes: number;
}

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
  /**
   * Tool-call counts per tool name (`repo_read_file`, `submit_decision`, …).
   * A count, not a ratio: an empty run yields an empty object.
   */
  toolCalls: Record<string, number>;
  /**
   * Cross-turn re-reads — the number of times a (path, line range) was returned
   * WITH content by repo_read_file in a different turn, minus one per range for
   * its first read. This is the quantity #25 optimises directly. A count, not a
   * ratio.
   */
  repeatedReads: number;
  /**
   * Bytes of already-read context carried into each later turn's context, one
   * entry per turn that carried. Empty when the carry is off (pre-#25 behaviour)
   * or when nothing was carried.
   */
  carriedBytes: number[];
  /**
   * Number of repo_save_evidence tool calls. The batch-save optimisation (#29)
   * reduces this from one call per evidence item to ~1 call per turn, so this is
   * the direct round-trip signal for that change. A count, not a ratio.
   */
  saveEvidenceCalls: number;
  /**
   * Bytes of the first-turn entry structure outline injected into context, one
   * entry per turn that injected (normally just the first turn). Empty when the
   * candidate had no entry files or none resolved to exported symbols.
   */
  entryOutlineBytes: number[];
  /**
   * Per-provider-call payload figures (the `provider_request` event from #36),
   * one entry per outgoing call, in call order. The bench summary derives
   * provider-call count, peak payload bytes and the two byte sums from this
   * array, so it is kept raw rather than pre-reduced. Empty when the session
   * never called the provider.
   */
  providerRequests: ProviderRequestRecord[];
  /**
   * Questions asked (prediction + follow-ups), read back from the persisted
   * session's `turnCount`. This is the product "completed a learning chain"
   * count for a real-repo benchmark. It comes from the store, not from counting
   * `turns`, because recap and degraded turns also live in that array and would
   * over-count.
   */
  turnCount: number;
}
