import { describe, expect, it } from "vitest";
import type {
  AgentDecision,
  Evidence,
  TokenUsage,
} from "../../src/domain";
import {
  Orchestrator,
  type AgentInvocation,
  type AgentInvoker,
  type AgentInvokerInput,
  type StepResult,
} from "../../src/orchestrator/orchestrator";
import { InMemorySessionStore } from "../../src/store";

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

const EVIDENCE: Evidence = {
  path: "src/index.ts",
  startLine: 1,
  endLine: 3,
  reason: "entry point",
};

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return { evidence: [], nextAction: "ask", ...overrides };
}

function stubAgent(
  respond: (input: AgentInvokerInput) => AgentInvocation,
): { agent: AgentInvoker; calls: AgentInvokerInput[] } {
  const calls: AgentInvokerInput[] = [];
  const agent: AgentInvoker = async (input) => {
    calls.push(input);
    return respond(input);
  };
  return { agent, calls };
}

function makeOrchestrator(
  agent: AgentInvoker,
  store: InMemorySessionStore,
  opts: { maxTurns?: number } = {},
): { orchestrator: Orchestrator; sessionId: string } {
  const session = store.createSession({
    repositoryId: "repo-1",
    featureId: "feature-1",
  });
  const orchestrator = new Orchestrator({
    agent,
    store,
    sessionId: session.id,
    featureGoal: "understand the parse flow",
    maxTurns: opts.maxTurns,
  });
  return { orchestrator, sessionId: session.id };
}

/** A happy-path agent: orientation → hypothesis → trace → questioning → feedback → recap. */
function happyPath(input: AgentInvokerInput): AgentInvocation {
  switch (input.phase) {
    case "orientation":
      return { decision: decision({ nextAction: "show_evidence" }), usage: USAGE };
    case "hypothesis":
      return {
        decision: decision({ question: "Where does parsing start?", nextAction: "ask" }),
        usage: USAGE,
      };
    case "trace":
      return {
        decision: decision({ evidence: [EVIDENCE], nextAction: "show_evidence" }),
        usage: USAGE,
      };
    case "questioning":
      return {
        decision: decision({ question: "Why is validation separate?", nextAction: "ask" }),
        usage: USAGE,
      };
    case "feedback":
      return {
        decision: decision({ assessment: "correct", feedback: "Spot on.", nextAction: "finish" }),
        usage: USAGE,
      };
    default:
      throw new Error(`unexpected phase ${input.phase}`);
  }
}

describe("Orchestrator", () => {
  it("drives the full happy path from orientation to recap", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent(happyPath);
    const { orchestrator, sessionId } = makeOrchestrator(agent, store);

    expect((await orchestrator.step()).phase).toBe("hypothesis"); // orientation → hypothesis
    expect((await orchestrator.step()).phase).toBe("hypothesis"); // ask prediction
    expect((await orchestrator.step("parse()")).phase).toBe("trace"); // answer → trace
    expect((await orchestrator.step()).phase).toBe("questioning"); // trace → questioning
    expect((await orchestrator.step()).phase).toBe("questioning"); // ask follow-up
    expect((await orchestrator.step("validation")).phase).toBe("feedback"); // answer → feedback

    const finalResult = await orchestrator.step(); // feedback → recap
    expect(finalResult.phase).toBe("recap");
    expect(finalResult.decisionOverridden).toBe(false);

    const persisted = store.getSession(sessionId);
    expect(persisted?.phase).toBe("recap");
    expect(persisted?.status).toBe("completed");
    expect(persisted?.turnCount).toBe(2); // prediction + one follow-up
    expect(store.listTurns(sessionId)).toHaveLength(7);
  });

  it("never enters trace without a user answer", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent((input) => {
      if (input.phase === "orientation") {
        return { decision: decision({ nextAction: "show_evidence" }), usage: USAGE };
      }
      // In hypothesis the agent tries to jump straight to showing evidence.
      return {
        decision: decision({ evidence: [EVIDENCE], nextAction: "show_evidence" }),
        usage: USAGE,
      };
    });
    const { orchestrator, sessionId } = makeOrchestrator(agent, store);

    await orchestrator.step(); // orientation → hypothesis
    const result = await orchestrator.step(); // hypothesis, no answer

    expect(result.phase).toBe("hypothesis");
    expect(result.decisionOverridden).toBe(true);
    expect(store.getSession(sessionId)?.phase).toBe("hypothesis");
  });

  it("records an explicit skip and still reaches trace", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent((input) => {
      if (input.phase === "orientation") {
        return { decision: decision({ nextAction: "show_evidence" }), usage: USAGE };
      }
      return { decision: decision({ question: "predict", nextAction: "ask" }), usage: USAGE };
    });
    const { orchestrator } = makeOrchestrator(agent, store);

    await orchestrator.step(); // orientation → hypothesis
    const result = await orchestrator.skip();

    expect(result.phase).toBe("trace");
    expect(result.turn?.skipped).toBe(true);
  });

  it("forces recap once the turn limit is reached", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent((input) => {
      switch (input.phase) {
        case "orientation":
          return { decision: decision({ nextAction: "show_evidence" }), usage: USAGE };
        case "hypothesis":
          return { decision: decision({ question: "q", nextAction: "ask" }), usage: USAGE };
        case "trace":
          return {
            decision: decision({ evidence: [EVIDENCE], nextAction: "show_evidence" }),
            usage: USAGE,
          };
        case "questioning":
          return { decision: decision({ question: "q", nextAction: "ask" }), usage: USAGE };
        case "feedback":
          // Always wants to probe deeper.
          return { decision: decision({ assessment: "correct", nextAction: "ask" }), usage: USAGE };
        default:
          throw new Error(`unexpected phase ${input.phase}`);
      }
    });
    const { orchestrator, sessionId } = makeOrchestrator(agent, store, {
      maxTurns: 5,
    });

    await orchestrator.step(); // orientation → hypothesis
    await orchestrator.step(); // ask prediction (turn 1)
    await orchestrator.step("a"); // → trace
    await orchestrator.step(); // trace → questioning

    let last: StepResult | undefined;
    for (let i = 0; i < 4; i++) {
      await orchestrator.step(); // ask follow-up (turns 2..5)
      await orchestrator.step("a"); // → feedback
      last = await orchestrator.step(); // feedback → questioning, or recap at the limit
    }

    expect(last?.phase).toBe("recap");
    expect(last?.decisionOverridden).toBe(true);
    expect(store.getSession(sessionId)?.phase).toBe("recap");
    expect(store.getSession(sessionId)?.turnCount).toBe(5);
  });

  it("lets the rules overrule an illegal nextAction suggestion", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent((input) => {
      if (input.phase === "orientation") {
        return { decision: decision({ nextAction: "finish" }), usage: USAGE };
      }
      return { decision: decision({ nextAction: "ask" }), usage: USAGE };
    });
    const { orchestrator, sessionId } = makeOrchestrator(agent, store);

    const result = await orchestrator.step(); // orientation, agent says "finish"

    expect(result.phase).toBe("orientation");
    expect(result.decisionOverridden).toBe(true);
    expect(store.getSession(sessionId)?.phase).toBe("orientation");
  });

  it("retries an invalid decision twice, then moves to error", async () => {
    const store = new InMemorySessionStore();
    let attempts = 0;
    const { agent, calls } = stubAgent(() => {
      attempts += 1;
      return {
        decision: { evidence: [], nextAction: "not-an-action" } as unknown as AgentDecision,
        usage: USAGE,
      };
    });
    const { orchestrator, sessionId } = makeOrchestrator(agent, store);

    const result = await orchestrator.step();

    expect(attempts).toBe(3); // initial + 2 retries
    expect(calls).toHaveLength(3);
    expect(result.phase).toBe("error");
    expect(result.decision).toBeNull();
    expect(store.getSession(sessionId)?.phase).toBe("error");
  });

  it("forces recap when the token budget is exceeded", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent((input) => {
      if (input.phase === "orientation") {
        return {
          decision: decision({ nextAction: "show_evidence" }),
          usage: { inputTokens: 300_000, outputTokens: 0 },
        };
      }
      return { decision: decision({ nextAction: "ask" }), usage: USAGE };
    });
    const { orchestrator } = makeOrchestrator(agent, store);

    const result = await orchestrator.step(); // orientation, over budget

    expect(result.phase).toBe("recap");
    expect(result.budgetExceeded).toBe(true);
    expect(result.decisionOverridden).toBe(true);
  });

  it("throws when stepped after reaching a terminal phase", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent(happyPath);
    const { orchestrator } = makeOrchestrator(agent, store);

    await orchestrator.step(); // orientation → hypothesis
    await orchestrator.step(); // ask prediction
    await orchestrator.step("a"); // → trace
    await orchestrator.step(); // trace → questioning
    await orchestrator.step(); // ask follow-up
    await orchestrator.step("a"); // → feedback
    await orchestrator.step(); // feedback → recap

    await expect(orchestrator.step()).rejects.toThrow(/terminal phase/);
  });
});
