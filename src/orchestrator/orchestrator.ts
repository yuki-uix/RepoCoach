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
  /** Max questions per session (default 5). */
  maxTurns?: number;
  budget?: TokenBudget;
}

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_BUDGET: TokenBudget = {
  maxInputTokens: 200_000,
  maxOutputTokens: 20_000,
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
  private readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(options: OrchestratorOptions) {
    this.agent = options.agent;
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.featureGoal = options.featureGoal;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.budget = options.budget ?? DEFAULT_BUDGET;
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

    const invocation = await this.invokeWithRetry(phase, session, input.userAnswer);
    if (invocation === null) {
      // The agent never produced a schema-valid decision. Give up.
      this.store.updateSession(this.sessionId, { phase: "error" });
      return {
        phase: "error",
        decision: null,
        decisionOverridden: false,
        turn: null,
        budgetExceeded: this.isBudgetExceeded(),
      };
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
      status: nextPhase === "recap" ? "completed" : session.status,
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
   * Call the agent and zod-validate the returned decision. Invalid decisions
   * are retried up to `MAX_DECISION_RETRIES` times; if none validates, return
   * null and the caller transitions to the `error` phase. Token usage is
   * accumulated on every attempt (failed calls still spend tokens).
   */
  private async invokeWithRetry(
    phase: Phase,
    session: LearningSession,
    userAnswer: string | undefined,
  ): Promise<{ decision: AgentDecision } | null> {
    for (let attempt = 0; attempt <= MAX_DECISION_RETRIES; attempt++) {
      const result = await this.agent({
        phase,
        featureGoal: this.featureGoal,
        turnHistory: this.store.listTurns(session.id),
        userAnswer,
      });
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
      // No answer yet: the agent is posing the prediction question.
      return { phase, askedQuestion: true, overridden: nextAction !== "ask" };
    }

    case "trace":
      if (nextAction !== "show_evidence") {
        return stayOverridden(phase);
      }
      // "unknown" assessment is how an evidence-less trace reports uncertainty
      // (docs/mvp-spec.md §8); it maps to the insufficient-evidence edge.
      return advance(
        phase,
        decision.assessment === "unknown"
          ? { type: "evidence_insufficient" }
          : { type: "evidence_sufficient" },
      );

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
      return { phase, askedQuestion: true, overridden: nextAction !== "ask" };
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
      return nextAction === "finish"
        ? advance(phase, { type: "chain_complete" })
        : advance(phase, { type: "continue_probing" });

    default:
      // recap / error are terminal; run() guards against them.
      throw new Error(`Unexpected phase "${phase}"`);
  }
}

function advance(phase: Phase, event: OrchestratorEvent): ResolveResult {
  return { phase: transition(phase, event), askedQuestion: false, overridden: false };
}

function stayOverridden(phase: Phase): ResolveResult {
  return { phase, askedQuestion: false, overridden: true };
}
