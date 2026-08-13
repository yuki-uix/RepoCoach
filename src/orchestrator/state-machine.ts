/**
 * Learning state machine — a pure transition function.
 *
 * Aligns with docs/architecture.md §4. The `phase` is held by the Orchestrator
 * and passed to the agent as context; the agent never chooses the phase. The
 * event is a discriminated union, and only the (phase, event) pairs listed in
 * `VALID_TRANSITIONS` are legal — anything else throws `InvalidTransitionError`.
 */

import type { Phase } from "../domain/index.js";

export type OrchestratorEvent =
  | { type: "repo_not_found" }
  | { type: "candidates_found" }
  | { type: "user_answered" }
  | { type: "user_skipped" }
  | { type: "evidence_sufficient" }
  | { type: "evidence_insufficient" }
  | { type: "turn_limit_reached" }
  | { type: "continue_probing" }
  | { type: "chain_complete" };

export type OrchestratorEventType = OrchestratorEvent["type"];

/** Every event the state machine knows about — used by tests to exhaust illegal edges. */
export const ALL_EVENTS: readonly OrchestratorEventType[] = [
  "repo_not_found",
  "candidates_found",
  "user_answered",
  "user_skipped",
  "evidence_sufficient",
  "evidence_insufficient",
  "turn_limit_reached",
  "continue_probing",
  "chain_complete",
];

/**
 * The complete transition table. Each entry maps an event to the phase it
 * leads to; this table IS the documentation. Any (phase, event) pair absent
 * here is invalid and `transition` rejects it.
 *
 *   orientation ──repo_not_found────────▶ error
 *   orientation ──candidates_found──────▶ hypothesis
 *   hypothesis  ──user_answered─────────▶ trace
 *   hypothesis  ──user_skipped──────────▶ trace     (skip is recorded on the turn)
 *   trace       ──evidence_sufficient───▶ questioning
 *   trace       ──evidence_insufficient─▶ questioning (ask clarification / unknown)
 *   questioning ──user_answered─────────▶ feedback
 *   questioning ──user_skipped──────────▶ feedback
 *   questioning ──turn_limit_reached────▶ recap
 *   feedback    ──continue_probing──────▶ questioning
 *   feedback    ──chain_complete────────▶ recap
 *   feedback    ──turn_limit_reached────▶ recap
 */
export const VALID_TRANSITIONS: Readonly<
  Record<Phase, Readonly<Partial<Record<OrchestratorEventType, Phase>>>>
> = {
  orientation: {
    repo_not_found: "error",
    candidates_found: "hypothesis",
  },
  hypothesis: {
    user_answered: "trace",
    user_skipped: "trace",
  },
  trace: {
    evidence_sufficient: "questioning",
    evidence_insufficient: "questioning",
  },
  questioning: {
    user_answered: "feedback",
    user_skipped: "feedback",
    turn_limit_reached: "recap",
  },
  feedback: {
    continue_probing: "questioning",
    chain_complete: "recap",
    turn_limit_reached: "recap",
  },
  recap: {},
  error: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly phase: Phase,
    public readonly event: OrchestratorEvent,
  ) {
    super(
      `Invalid transition: "${event.type}" is not allowed from phase "${phase}"`,
    );
    this.name = "InvalidTransitionError";
  }
}

/** Return the phase produced by `event` in `current`, or throw if illegal. */
export function transition(current: Phase, event: OrchestratorEvent): Phase {
  const next = VALID_TRANSITIONS[current][event.type];
  if (next === undefined) {
    throw new InvalidTransitionError(current, event);
  }
  return next;
}
