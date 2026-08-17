import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatProvider } from "../../src/agent";
import { assembleSession, runCli } from "../../src/cli";
import { DEFAULT_BUDGET } from "../../src/orchestrator/orchestrator";
import { JsonSessionStore, resumeSession } from "../../src/store";
import { capturedStreams, fixtureRoot, makeDataDir, scriptedProvider, toolMessage } from "./helpers";

/**
 * A provider that always submits `show_evidence` and reports the given input
 * token spend — the minimal script to prove the token budget is applied.
 */
function spendingProvider(inputTokens: number): ChatProvider {
  return {
    async complete() {
      return {
        message: toolMessage("c1", "submit_decision", {
          evidence: [],
          nextAction: "show_evidence",
        }),
        usage: { inputTokens, outputTokens: 1 },
      };
    },
  };
}

/** A provider that drops the connection on the first call, leaving the session active. */
function crashingProvider(): ChatProvider {
  return {
    async complete() {
      throw new Error("connection dropped (simulated crash)");
    },
  };
}

/**
 * Nine submit_decision steps that keep probing deeper, to drive the turn limit:
 * orientation → hypothesis(q1) → trace → questioning(q2) → feedback → probe(q3)
 * → feedback → probe(q4, blocked). Each step is one provider call because the
 * decisions carry no evidence (no repo reads before submit).
 */
const TURN_LIMIT_SCRIPT = [
  toolMessage("s1", "submit_decision", { evidence: [], nextAction: "show_evidence" }),
  toolMessage("s2", "submit_decision", { question: "q1", evidence: [], nextAction: "ask" }),
  toolMessage("s3", "submit_decision", { question: "q1", evidence: [], nextAction: "ask" }),
  toolMessage("s4", "submit_decision", {
    evidence: [],
    assessment: "unknown",
    nextAction: "show_evidence",
  }),
  toolMessage("s5", "submit_decision", { question: "q2", evidence: [], nextAction: "ask" }),
  toolMessage("s6", "submit_decision", { evidence: [], nextAction: "finish" }),
  toolMessage("s7", "submit_decision", { question: "q3", evidence: [], nextAction: "ask" }),
  toolMessage("s8", "submit_decision", { evidence: [], nextAction: "finish" }),
  toolMessage("s9", "submit_decision", { question: "q4", evidence: [], nextAction: "ask" }),
];

describe("start/resume turn and budget overrides (default assembly)", () => {
  it("start persists the flag overrides on the session", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    streams.stdin.write("1\n");
    const code = await runCli(
      ["start", fixtureRoot, "--max-turns", "3", "--max-input-tokens", "2000", "--max-output-tokens", "100"],
      {
        dataDir,
        provider: crashingProvider(),
        stdin: streams.stdin,
        stdout: streams.stdout,
        stderr: streams.stderr,
      },
    );
    streams.stdin.end();

    // Crashed on the first agent call; the session stays active and persisted.
    expect(code).toBe(1);
    const session = new JsonSessionStore(dataDir).listSessions()[0];
    expect(session?.maxTurns).toBe(3);
    expect(session?.budget).toEqual({ maxInputTokens: 2000, maxOutputTokens: 100 });
  });

  it("resume applies the persisted budget instead of falling back to the default", async () => {
    const dataDir = makeDataDir();
    const streams1 = capturedStreams();
    streams1.stdin.write("1\n");
    const code1 = await runCli(["start", fixtureRoot, "--max-input-tokens", "2000"], {
      dataDir,
      provider: crashingProvider(),
      stdin: streams1.stdin,
      stdout: streams1.stdout,
      stderr: streams1.stderr,
    });
    streams1.stdin.end();
    expect(code1).toBe(1);

    const session = new JsonSessionStore(dataDir).listSessions()[0];
    // A partial budget fills the missing half from DEFAULT_BUDGET.
    expect(session?.budget).toEqual({
      maxInputTokens: 2000,
      maxOutputTokens: DEFAULT_BUDGET.maxOutputTokens,
    });

    // Fresh assembly on the same dataDir (a "process restart"), then resume.
    const asm2 = assembleSession({ dataDir, provider: spendingProvider(5000) });
    const resumed = resumeSession(asm2.store, session!.id);
    const repo = await asm2.reader.importRepository(resumed.session.repositoryId);
    const { orchestrator } = asm2.buildOrchestrator(repo, resumed.sessionId, "goal");

    // 5000 input tokens exceed the 2000 budget the session was started with, so
    // the first call must recap. Falling back to the 320k default would not.
    const result = await orchestrator.step();
    expect(result.budgetExceeded).toBe(true);
    expect(result.phase).toBe("recap");
  });

  it("buildOrchestrator applies a persisted maxTurns override", async () => {
    const dataDir = makeDataDir();
    const asm = assembleSession({ dataDir, provider: scriptedProvider(TURN_LIMIT_SCRIPT) });
    const repo = await asm.reader.importRepository(fixtureRoot);
    const session = asm.store.createSession({
      repositoryId: fixtureRoot,
      featureId: "task-creation",
      maxTurns: 3,
    });

    const { orchestrator } = asm.buildOrchestrator(repo, session.id, "goal");

    await orchestrator.step(); // orientation → hypothesis
    await orchestrator.step(); // prediction (turn 1)
    await orchestrator.step("a"); // → trace
    await orchestrator.step(); // → questioning
    await orchestrator.step(); // follow-up (turn 2)
    await orchestrator.step("a"); // → feedback
    const probe = await orchestrator.step(); // probe deeper (turn 3) → questioning
    expect(probe.phase).toBe("questioning");
    await orchestrator.step("a"); // → feedback
    const last = await orchestrator.step(); // 4th probe attempt → recap

    expect(last.phase).toBe("recap");
    expect(last.decisionOverridden).toBe(true);
    expect(asm.store.getSession(session.id)?.turnCount).toBe(3);
  });

  it("resumes a legacy session file without the override fields using defaults", async () => {
    const dataDir = makeDataDir();
    const store = new JsonSessionStore(dataDir);
    const session = store.createSession({
      repositoryId: fixtureRoot,
      featureId: "task-creation",
    });

    // A pre-override session file carries no maxTurns / budget keys.
    const raw = readFileSync(join(dataDir, "sessions", `${session.id}.json`), "utf8");
    expect(raw).not.toContain("maxTurns");
    expect(raw).not.toContain("maxInputTokens");

    // Resuming it must fall back to the default budget: spending one more than
    // the default input limit is over budget.
    const asm = assembleSession({
      dataDir,
      provider: spendingProvider(DEFAULT_BUDGET.maxInputTokens + 1),
    });
    const resumed = resumeSession(asm.store, session.id);
    const repo = await asm.reader.importRepository(resumed.session.repositoryId);
    const { orchestrator } = asm.buildOrchestrator(repo, resumed.sessionId, "goal");

    const result = await orchestrator.step();
    expect(result.budgetExceeded).toBe(true);
    expect(result.phase).toBe("recap");
  });
});
