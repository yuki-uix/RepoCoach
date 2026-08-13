import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDecision,
  Evidence,
  LearningTurn,
  TokenUsage,
} from "../../src/domain";
import {
  Orchestrator,
  type AgentInvocation,
  type AgentInvoker,
  type AgentInvokerInput,
} from "../../src/orchestrator/orchestrator";
import { JsonSessionStore, resumeSession } from "../../src/store";

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

const EVIDENCE: Evidence = {
  path: "src/parse/task.ts",
  startLine: 1,
  endLine: 3,
  reason: "parse entry point",
};

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return { evidence: [], nextAction: "ask", ...overrides };
}

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

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "repocoach-sessions-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("JsonSessionStore", () => {
  it("round-trips a session and every turn field through a fresh instance", () => {
    const first = new JsonSessionStore(dataDir);
    const session = first.createSession({
      repositoryId: "repo-1",
      featureId: "feature-1",
    });

    const turn1: LearningTurn = {
      sessionId: session.id,
      question: "Where does parsing start?",
      userAnswer: "parse()",
      evidence: [EVIDENCE],
      assessment: "partial",
      feedback: "Close.",
      skipped: false,
      decisionOverridden: true,
    };
    const turn2: LearningTurn = {
      sessionId: session.id,
      question: "Why is validation separate?",
      evidence: [
        { path: "src/parse/validate.ts", startLine: 4, endLine: 6, reason: "validation" },
      ],
      assessment: "correct",
      feedback: "Exactly.",
      skipped: true,
      decisionOverridden: false,
    };
    first.appendTurn(turn1);
    first.appendTurn(turn2);

    const second = new JsonSessionStore(dataDir);
    expect(second.getSession(session.id)).toEqual(session);
    expect(second.listTurns(session.id)).toEqual([turn1, turn2]);
  });

  it("stamps createdAt / updatedAt / completedAt and reports duration", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const store = new JsonSessionStore(dataDir);
      const session = store.createSession({
        repositoryId: "repo-1",
        featureId: "feature-1",
      });

      expect(session.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(session.updatedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(session.completedAt).toBeUndefined();

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
      store.updateSession(session.id, { phase: "recap", status: "completed" });

      const done = store.getSession(session.id);
      expect(done?.updatedAt).toBe("2026-01-01T00:05:00.000Z");
      expect(done?.completedAt).toBe("2026-01-01T00:05:00.000Z");
      expect(store.sessionDuration(session.id)).toBe(300_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a leftover .tmp file and lists only real sessions", () => {
    const store = new JsonSessionStore(dataDir);
    const session = store.createSession({
      repositoryId: "repo-1",
      featureId: "feature-1",
    });
    writeFileSync(
      join(dataDir, "sessions", `${session.id}.json.tmp`),
      "garbage from an interrupted write",
      "utf8",
    );

    const reloaded = new JsonSessionStore(dataDir);
    expect(reloaded.getSession(session.id)).toEqual(session);
    expect(reloaded.listSessions().map((s) => s.id)).toEqual([session.id]);
  });

  it("rejects corrupted files with a path, never the contents", () => {
    const sessionsDir = join(dataDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "leaky.json"), '{"secret":"LEAKME",', "utf8");
    writeFileSync(
      join(sessionsDir, "schema.json"),
      JSON.stringify({ session: { id: "x" } }),
      "utf8",
    );

    const store = new JsonSessionStore(dataDir);
    expect(() => store.getSession("leaky")).toThrow(/Corrupted session file/);
    expect(() => store.getSession("leaky")).toThrow(/leaky\.json/);
    expect(() => store.getSession("leaky")).not.toThrow(/LEAKME/);
    expect(() => store.getSession("schema")).toThrow(/schema mismatch/);
    expect(() => store.getSession("schema")).toThrow(/schema\.json/);
  });
});

describe("resumeSession", () => {
  it("returns constructable data for an active session", () => {
    const store = new JsonSessionStore(dataDir);
    const session = store.createSession({
      repositoryId: "repo-1",
      featureId: "feature-1",
    });

    const resumed = resumeSession(store, session.id);
    expect(resumed.sessionId).toBe(session.id);
    expect(resumed.featureGoal).toBe("feature-1");
    expect(resumed.session).toEqual(session);
  });

  it("rejects unknown and completed sessions", () => {
    const store = new JsonSessionStore(dataDir);
    expect(() => resumeSession(store, "missing")).toThrow(/Unknown session/);

    const session = store.createSession({
      repositoryId: "repo-1",
      featureId: "feature-1",
    });
    store.updateSession(session.id, { phase: "recap", status: "completed" });
    expect(() => resumeSession(store, session.id)).toThrow(
      /Cannot resume session/,
    );
  });
});

describe("session resume (end to end)", () => {
  it("continues an interrupted session from questioning to recap", async () => {
    const agent: AgentInvoker = async (input) => happyPath(input);

    // Drive a session to questioning, then drop the orchestrator and store —
    // the process "crashed" mid-session.
    const sessionId = await runToQuestioning(dataDir, agent);

    // Rebuild from the same data directory and resume.
    const resumedStore = new JsonSessionStore(dataDir);
    const resumed = resumeSession(resumedStore, sessionId);
    const orchestrator = new Orchestrator({
      agent,
      store: resumedStore,
      sessionId: resumed.sessionId,
      featureGoal: resumed.featureGoal,
    });

    expect((await orchestrator.step()).phase).toBe("questioning"); // ask follow-up
    expect((await orchestrator.step("validation")).phase).toBe("feedback");
    expect((await orchestrator.step()).phase).toBe("recap"); // feedback → recap

    const persisted = resumedStore.getSession(sessionId);
    expect(persisted?.phase).toBe("recap");
    expect(persisted?.status).toBe("completed");
    expect(persisted?.turnCount).toBe(2); // prediction + one follow-up

    const turns = resumedStore.listTurns(sessionId);
    expect(turns).toHaveLength(7);
    // Historical evidence from before the "crash" is preserved field-for-field.
    expect(turns[3].sessionId).toBe(sessionId);
    expect(turns[3].evidence).toEqual([EVIDENCE]);
  });
});

async function runToQuestioning(dataDir: string, agent: AgentInvoker): Promise<string> {
  const store = new JsonSessionStore(dataDir);
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

  await orchestrator.step(); // orientation → hypothesis
  await orchestrator.step(); // ask prediction
  await orchestrator.step("parse()"); // answer → trace
  expect((await orchestrator.step()).phase).toBe("questioning"); // trace → questioning

  return session.id;
}
