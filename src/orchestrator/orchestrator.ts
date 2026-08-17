/**
 * Learning Orchestrator — drives the state machine, the agent and the store.
 *
 * The Orchestrator owns the `phase` and feeds it to the agent as context. The
 * agent's `nextAction` is only a suggestion: the Orchestrator arbitrates it
 * against the state machine, the turn limit and the token budget, and records
 * on each LearningTurn whether the suggestion was overruled.
 *
 * See docs/architecture.md §3–§5.
 */

import { AgentDecisionInvalidError } from "../agent/index.js";
import {
  agentDecisionSchema,
  type AgentDecision,
  type LearningSession,
  type LearningTurn,
  type Phase,
  type TokenBudget,
  type TokenUsage,
} from "../domain/index.js";
import type { SessionStore } from "../store/index.js";
import { transition, type OrchestratorEvent } from "./state-machine.js";

export interface AgentInvokerInput {
  phase: Phase;
  featureGoal: string;
  turnHistory: LearningTurn[];
  userAnswer?: string;
  /** True when the user skipped the question instead of answering. */
  skipped?: boolean;
}

/** The agent's structured decision plus the token usage for the call. */
export interface AgentInvocation {
  decision: AgentDecision;
  usage: TokenUsage;
}

/** Injected agent seam. The real DeepSeek loop arrives in issue #4. */
export interface AgentInvoker {
  (input: AgentInvokerInput): Promise<AgentInvocation>;
}

export interface StepResult {
  phase: Phase;
  decision: AgentDecision | null;
  /** True when the Orchestrator overruled the agent's suggested nextAction. */
  decisionOverridden: boolean;
  turn: LearningTurn | null;
  /** True when this step pushed the session over its token budget. */
  budgetExceeded: boolean;
}

export interface OrchestratorOptions {
  agent: AgentInvoker;
  store: SessionStore;
  sessionId: string;
  featureGoal: string;
  /** Max questions per session (default 3). */
  maxTurns?: number;
  budget?: TokenBudget;
  /**
   * Token usage already accumulated before this Orchestrator was built — a
   * resumed session passes its persisted usage so the budget limit keeps
   * counting across interruptions instead of resetting.
   */
  initialUsage?: TokenUsage;
}

/**
 * Default questions per session. Lowered from 5 to 3 (issue #33): a single
 * real-repository question costs 330–360k tokens, so five questions never fit
 * the 320k budget — measured runs complete only one. Three questions is the
 * smallest full "predict → correct → restate" loop.
 */
export const DEFAULT_MAX_TURNS = 3;
/**
 * Default per-session token budget. Measured from real-model smoke runs: two
 * 4-question sessions consumed 121,972 input / 20,997 output and 199,241 input
 * / 43,817 output tokens (both hit the then-current output cap and were forced
 * to converge early), and a complete 5-question run measured 235,399 input /
 * 53,720 output. These limits leave headroom above that measured full run. Cost
 * grows linearly with turns because of cross-turn re-reads (issue #25).
 */
export const DEFAULT_BUDGET: TokenBudget = {
  maxInputTokens: 320_000,
  maxOutputTokens: 70_000,
};
const MAX_DECISION_RETRIES = 2;

interface RunInput {
  userAnswer?: string;
  skip?: boolean;
}

interface ResolveResult {
  phase: Phase;
  /** True when the agent posed a question (increments turnCount). */
  askedQuestion: boolean;
  overridden: boolean;
}

export class Orchestrator {
  private readonly agent: AgentInvoker;
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly featureGoal: string;
  private readonly maxTurns: number;
  private readonly budget: TokenBudget;
  private readonly usage: TokenUsage;

  constructor(options: OrchestratorOptions) {
    this.agent = options.agent;
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.featureGoal = options.featureGoal;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.usage = options.initialUsage
      ? { ...options.initialUsage }
      : { inputTokens: 0, outputTokens: 0 };
  }

  /** Cumulative token usage across every agent call in this session. */
  get accumulatedUsage(): TokenUsage {
    return { ...this.usage };
  }

  /** Advance the session by one agent turn, using `userAnswer` as the reply. */
  async step(userAnswer?: string): Promise<StepResult> {
    return this.run({ userAnswer });
  }

  /** Advance the session with an explicit "skip" instead of an answer. */
  async skip(): Promise<StepResult> {
    return this.run({ skip: true });
  }

  private async run(input: RunInput): Promise<StepResult> {
    const session = this.requireSession();
    const phase = session.phase;

    if (phase === "recap" || phase === "error") {
      throw new Error(
        `Cannot step: session "${session.id}" is already in terminal phase "${phase}"`,
      );
    }

    const invocation = await this.invokeWithRetry(phase, session, input);
    if (invocation === null) {
      // The agent never produced a schema-valid decision. If the session
      // already has something worth recapping, salvage a minimal recap instead
      // of throwing the learner's work away; otherwise abandon with a resume
      // hint (see the finishSession error message).
      return this.degrade();
    }
    const { decision } = invocation;

    const budgetExceeded = this.isBudgetExceeded();
    const plan = resolveStep(phase, decision, input, {
      turnLimitReached: session.turnCount >= this.maxTurns,
      budgetExceeded,
    });

    const turnCount = plan.askedQuestion
      ? session.turnCount + 1
      : session.turnCount;
    const nextPhase = plan.phase;

    const turn: LearningTurn = {
      sessionId: this.sessionId,
      question: decision.question ?? "",
      userAnswer: input.userAnswer,
      evidence: decision.evidence,
      assessment: decision.assessment,
      feedback: decision.feedback,
      skipped: input.skip,
      decisionOverridden: plan.overridden || undefined,
    };

    this.store.appendTurn(turn);
    this.store.updateSession(this.sessionId, {
      phase: nextPhase,
      turnCount,
      status: terminalStatus(nextPhase) ?? session.status,
      usage: this.accumulatedUsage,
    });

    return {
      phase: nextPhase,
      decision,
      decisionOverridden: plan.overridden,
      turn,
      budgetExceeded,
    };
  }

  private requireSession(): LearningSession {
    const session = this.store.getSession(this.sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${this.sessionId}`);
    }
    return session;
  }

  /**
   * Handle the agent never producing a valid decision: salvage a minimal recap
   * when the session already has evidence or posed questions, otherwise abandon
   * the session. Either way the learner keeps whatever was persisted.
   */
  private degrade(): StepResult {
    const turns = this.store.listTurns(this.sessionId);
    const hasContent = turns.some(
      (turn) => turn.question.trim() !== "" || turn.evidence.length > 0,
    );
    if (!hasContent) {
      this.store.updateSession(this.sessionId, {
        phase: "error",
        status: "abandoned",
        usage: this.accumulatedUsage,
      });
      return {
        phase: "error",
        decision: null,
        decisionOverridden: false,
        turn: null,
        budgetExceeded: this.isBudgetExceeded(),
      };
    }
    // Record the degradation as a turn so it persists with the session, then
    // close out as a completed (degraded) recap. `renderRecap` ignores a
    // question-only turn, so it does not pollute the sections.
    this.store.appendTurn({
      sessionId: this.sessionId,
      question: "Session 降级：模型未能产出有效决策，本次复盘由已保存证据合成。",
      evidence: [],
    });
    this.store.updateSession(this.sessionId, {
      phase: "recap",
      status: "completed",
      usage: this.accumulatedUsage,
    });
    return {
      phase: "recap",
      decision: null,
      decisionOverridden: true,
      turn: null,
      budgetExceeded: this.isBudgetExceeded(),
    };
  }

  /**
   * Call the agent and zod-validate the returned decision. Invalid decisions
   * are retried up to `MAX_DECISION_RETRIES` times; if none validates, return
   * null and the caller transitions to the `error` phase. Token usage is
   * accumulated on every attempt (failed calls still spend tokens).
   */
  private async invokeWithRetry(
    phase: Phase,
    session: LearningSession,
    input: RunInput,
  ): Promise<{ decision: AgentDecision } | null> {
    for (let attempt = 0; attempt <= MAX_DECISION_RETRIES; attempt++) {
      let result: AgentInvocation;
      try {
        result = await this.agent({
          phase,
          featureGoal: this.featureGoal,
          turnHistory: this.store.listTurns(session.id),
          userAnswer: input.userAnswer,
          skipped: input.skip,
        });
      } catch (error) {
        // The real AgentLoop throws once its own retries are exhausted; there
        // is nothing a further Orchestrator-level retry could recover. The
        // failed call still spent provider tokens, so fold them into the
        // running total before degrading — otherwise a burst of failures would
        // under-count usage and let the budget check be bypassed.
        if (error instanceof AgentDecisionInvalidError) {
          this.usage.inputTokens += error.usage.inputTokens;
          this.usage.outputTokens += error.usage.outputTokens;
          return null;
        }
        throw error;
      }
      this.usage.inputTokens += result.usage.inputTokens;
      this.usage.outputTokens += result.usage.outputTokens;

      const parsed = agentDecisionSchema.safeParse(result.decision);
      if (parsed.success) {
        return { decision: parsed.data };
      }
    }
    return null;
  }

  private isBudgetExceeded(): boolean {
    return (
      this.usage.inputTokens > this.budget.maxInputTokens ||
      this.usage.outputTokens > this.budget.maxOutputTokens
    );
  }
}

/**
 * Decide the next phase for a single step, applying the Orchestrator's rules
 * over the agent's `nextAction` suggestion. Returns whether a question was
 * asked (to bump turnCount) and whether the suggestion was overruled.
 */
function resolveStep(
  phase: Phase,
  decision: AgentDecision,
  input: RunInput,
  opts: { turnLimitReached: boolean; budgetExceeded: boolean },
): ResolveResult {
  const nextAction = decision.nextAction;

  // The token budget is a hard stop: recap regardless of what the agent asked.
  if (opts.budgetExceeded) {
    return { phase: "recap", askedQuestion: false, overridden: true };
  }

  switch (phase) {
    case "orientation":
      // "show_evidence" means "propose feature candidates".
      return nextAction === "show_evidence"
        ? advance(phase, { type: "candidates_found" })
        : stayOverridden(phase);

    case "hypothesis": {
      // The trace phase may only be entered after a user answer or an
      // explicit skip — the agent's nextAction alone cannot authorise it.
      if (input.skip) {
        return advance(phase, { type: "user_skipped" });
      }
      if (input.userAnswer !== undefined) {
        return advance(phase, { type: "user_answered" });
      }
      // No answer yet: the session stays in hypothesis. A non-empty question
      // in the decision is posed to the user (whatever the nextAction) and so
      // counts as a turn; a question-less suggestion is overruled and does not.
      return { phase, askedQuestion: hasQuestion(decision), overridden: nextAction !== "ask" };
    }

    case "trace": {
      if (nextAction !== "show_evidence") {
        return stayOverridden(phase);
      }
      // "unknown" assessment is how an evidence-less trace reports uncertainty
      // (docs/mvp-spec.md §8); it maps to the insufficient-evidence edge. An
      // empty evidence array is equally inconclusive — no evidence to stand on.
      const evidenceInsufficient =
        decision.assessment === "unknown" || decision.evidence.length === 0;
      return advance(
        phase,
        evidenceInsufficient
          ? { type: "evidence_insufficient" }
          : { type: "evidence_sufficient" },
      );
    }

    case "questioning": {
      // The user's answer completes this turn and moves to feedback — even
      // when the turn limit has been reached. The limit blocks the *next*
      // question, not the answer to the last allowed one.
      if (input.skip || input.userAnswer !== undefined) {
        return advance(
          phase,
          input.skip ? { type: "user_skipped" } : { type: "user_answered" },
        );
      }
      // No answer yet: the agent wants to pose a follow-up. At the turn limit
      // we must recap instead of asking another question.
      if (opts.turnLimitReached) {
        return {
          phase: transition(phase, { type: "turn_limit_reached" }),
          askedQuestion: false,
          overridden: true,
        };
      }
      return { phase, askedQuestion: hasQuestion(decision), overridden: nextAction !== "ask" };
    }

    case "feedback":
      // At the turn limit, finishing is fine but probing deeper is not.
      if (opts.turnLimitReached && nextAction !== "finish") {
        return {
          phase: transition(phase, { type: "turn_limit_reached" }),
          askedQuestion: false,
          overridden: true,
        };
      }
      // Probing deeper poses a fresh question immediately after this transition
      // (the runner shows it right away), so any non-empty question must count
      // toward the turn limit — regardless of the nextAction. A question-less
      // non-finish suggestion is overruled.
      return nextAction === "finish"
        ? advance(phase, { type: "chain_complete" })
        : {
            phase: transition(phase, { type: "continue_probing" }),
            askedQuestion: hasQuestion(decision),
            overridden: nextAction !== "ask",
          };

    default:
      // recap / error are terminal; run() guards against them.
      throw new Error(`Unexpected phase "${phase}"`);
  }
}

/** True when a decision carries a non-empty question to pose to the user. */
function hasQuestion(decision: AgentDecision): boolean {
  return decision.question !== undefined && decision.question.trim() !== "";
}

function advance(phase: Phase, event: OrchestratorEvent): ResolveResult {
  return { phase: transition(phase, event), askedQuestion: false, overridden: false };
}

function stayOverridden(phase: Phase): ResolveResult {
  return { phase, askedQuestion: false, overridden: true };
}

/**
 * The session `status` a terminal phase implies: `recap` means the session was
 * completed, `error` means it was abandoned. Non-terminal phases keep the
 * current status.
 */
function terminalStatus(phase: Phase): "completed" | "abandoned" | undefined {
  if (phase === "recap") return "completed";
  if (phase === "error") return "abandoned";
  return undefined;
}
