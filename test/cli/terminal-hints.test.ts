import { describe, expect, it, vi } from "vitest";
import { assembleSession, runCli, SessionRunner } from "../../src/cli";
import {
  capturedStreams,
  fixtureRoot,
  fullSessionScript,
  makeDataDir,
  scriptedProvider,
} from "./helpers";

describe("CLI terminal-phase hints", () => {
  it("does not offer resume when a session reaches the error terminal phase", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    streams.stdin.write("1\n");

    // A provider that only ever returns plain text drives the AgentLoop past
    // its tool-call limit, where it throws AgentDecisionInvalidError; with no
    // prior content the Orchestrator degrades to the `error` terminal phase.
    const plainText = { role: "assistant", content: "just text, no tool call" } as const;
    const provider = scriptedProvider(Array.from({ length: 20 }, () => plainText));

    const code = await runCli(["start", fixtureRoot], {
      dataDir,
      provider,
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    streams.stdin.end();

    expect(code).toBe(1);
    const err = streams.stderrText();
    expect(err).toContain("error 状态");
    // A terminal session cannot be resumed, so the hint must not say so.
    expect(err).not.toContain("resume");
    // It points at the persisted evidence (via `show`, which actually renders
    // it) and a fresh start instead.
    expect(err).toContain("show");
    expect(err).toContain("start");
  });

  it("still offers resume after a SIGINT interrupt during an active session", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    const asm = assembleSession({
      dataDir,
      provider: scriptedProvider(fullSessionScript()),
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    const repo = await asm.reader.importRepository(fixtureRoot);
    const session = asm.store.createSession({ repositoryId: fixtureRoot, featureId: "task-creation" });

    // Hold the runner at the question prompt (active, non-terminal) so the
    // "interrupt" fires while the session is genuinely resumable.
    let releasePrompt!: (line: string) => void;
    let signalPromptReached!: () => void;
    const promptReached = new Promise<void>((resolve) => {
      signalPromptReached = resolve;
    });
    const prompt = async (): Promise<string> => {
      signalPromptReached();
      return new Promise((resolve) => {
        releasePrompt = resolve;
      });
    };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const target = { sink: null };
      const { orchestrator } = asm.buildOrchestrator(repo, session.id, "goal", (event) =>
        target.sink?.push(event),
      );
      const runner = new SessionRunner({
        orchestrator,
        store: asm.store,
        sessionId: session.id,
        stdout: streams.stdout,
        stderr: streams.stderr,
        prompt,
        target,
      });

      const runPromise = runner.run();
      await promptReached; // active + non-terminal: blocked on the question

      process.emit("SIGINT");
      expect(streams.stderrText()).toContain("resume");

      releasePrompt("/quit"); // unwind so the runner removes its listener
      await runPromise;
    } finally {
      exitSpy.mockRestore();
    }
  });
});
