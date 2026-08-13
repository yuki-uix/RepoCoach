import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, Evidence, TokenUsage } from "../../src/domain";
import {
  Orchestrator,
  type AgentInvocation,
  type AgentInvoker,
  type AgentInvokerInput,
} from "../../src/orchestrator/orchestrator";
import { transition } from "../../src/orchestrator/state-machine";
import { InMemorySessionStore } from "../../src/store";

vi.mock("../../src/orchestrator/state-machine", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/orchestrator/state-machine")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});

const mockedTransition = vi.mocked(transition);

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return { evidence: [], nextAction: "ask", ...overrides };
}

function stubAgent(
  respond: (input: AgentInvokerInput) => AgentInvocation,
): { agent: AgentInvoker } {
  const agent: AgentInvoker = async (input) => respond(input);
  return { agent };
}

function makeOrchestrator(agent: AgentInvoker, store: InMemorySessionStore) {
  const session = store.createSession({
    repositoryId: "repo-1",
    featureId: "feature-1",
  });
  const orchestrator = new Orchestrator({
    agent,
    store,
    sessionId: session.id,
    featureGoal: "understand the parse flow",
  });
  return { orchestrator };
}

describe("trace evidence routing", () => {
  beforeEach(() => {
    mockedTransition.mockClear();
  });

  it("routes empty evidence to the insufficient edge even with a non-unknown assessment", async () => {
    const store = new InMemorySessionStore();
    const { agent } = stubAgent((input) => {
      switch (input.phase) {
        case "orientation":
          return { decision: decision({ nextAction: "show_evidence" }), usage: USAGE };
        case "hypothesis":
          return { decision: decision({ question: "q", nextAction: "ask" }), usage: USAGE };
        case "trace":
          return {
            decision: decision({
              assessment: "correct",
              evidence: [],
              nextAction: "show_evidence",
            }),
            usage: USAGE,
          };
        default:
          throw new Error(`unexpected phase ${input.phase}`);
      }
    });
    const { orchestrator } = makeOrchestrator(agent, store);

    await orchestrator.step(); // orientation → hypothesis
    await orchestrator.step(); // ask prediction
    await orchestrator.step("a"); // answer → trace
    const result = await orchestrator.step(); // trace with empty evidence

    expect(result.phase).toBe("questioning");
    expect(mockedTransition).toHaveBeenCalledWith("trace", {
      type: "evidence_insufficient",
    });
    expect(mockedTransition).not.toHaveBeenCalledWith("trace", {
      type: "evidence_sufficient",
    });
  });

  it("routes non-empty evidence with a non-unknown assessment to the sufficient edge", async () => {
    const EVIDENCE: Evidence = {
      path: "src/index.ts",
      startLine: 1,
      endLine: 3,
      reason: "entry point",
    };
    const store = new InMemorySessionStore();
    const { agent } = stubAgent((input) => {
      switch (input.phase) {
        case "orientation":
          return { decision: decision({ nextAction: "show_evidence" }), usage: USAGE };
        case "hypothesis":
          return { decision: decision({ question: "q", nextAction: "ask" }), usage: USAGE };
        case "trace":
          return {
            decision: decision({
              assessment: "correct",
              evidence: [EVIDENCE],
              nextAction: "show_evidence",
            }),
            usage: USAGE,
          };
        default:
          throw new Error(`unexpected phase ${input.phase}`);
      }
    });
    const { orchestrator } = makeOrchestrator(agent, store);

    await orchestrator.step(); // orientation → hypothesis
    await orchestrator.step(); // ask prediction
    await orchestrator.step("a"); // answer → trace
    const result = await orchestrator.step(); // trace with evidence

    expect(result.phase).toBe("questioning");
    expect(mockedTransition).toHaveBeenCalledWith("trace", {
      type: "evidence_sufficient",
    });
  });
});
