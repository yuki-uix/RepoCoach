import { describe, expect, it } from "vitest";
import { assembleSession, renderRecap, SessionRunner, type SessionAssembly } from "../../src/cli";
import type { Repository } from "../../src/reader";
import { resumeSession } from "../../src/store";
import { capturedStreams, fixtureRoot, fullSessionScript, makeDataDir, scriptedProvider } from "./helpers";

describe("CLI resume (AC4)", () => {
  it("continues an interrupted session from questioning to recap via resume", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    // One provider instance spans the "crash": the script is consumed across
    // both phases, so the resume continues where the interrupted run stopped.
    const provider = scriptedProvider(fullSessionScript());

    // Phase 1 — drive to questioning, then drop everything.
    const asm1 = assembleSession({
      dataDir,
      provider,
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    const repo1 = await asm1.reader.importRepository(fixtureRoot);
    const session = asm1.store.createSession({
      repositoryId: fixtureRoot,
      featureId: "task-creation",
    });

    const runner1 = makeRunner(asm1, repo1, session.id, streams);
    await runner1.advance(); // orientation → hypothesis
    await runner1.advance(); // ask prediction
    await runner1.advance({ answer: "parseTask → validate → store → render" }); // → trace
    await runner1.advance(); // trace → questioning
    expect(asm1.store.getSession(session.id)?.phase).toBe("questioning");

    // Phase 2 — rebuild from the same dataDir and resume.
    const asm2 = assembleSession({
      dataDir,
      provider,
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    const resumed = resumeSession(asm2.store, session.id);
    expect(resumed.sessionId).toBe(session.id);
    const repo2 = await asm2.reader.importRepository(resumed.session.repositoryId);
    const runner2 = makeRunner(asm2, repo2, resumed.sessionId, streams);

    await runner2.advance(); // ask follow-up
    await runner2.advance({ answer: "parseTask generates the id" }); // → feedback
    await runner2.advance(); // feedback → recap

    const done = asm2.store.getSession(session.id);
    expect(done?.phase).toBe("recap");
    expect(done?.status).toBe("completed");

    // Historical evidence survives the resume: the recap merges the persisted
    // turn evidence even though the fresh in-memory evidence store is empty.
    const recap = renderRecap({
      sessionId: session.id,
      evidenceStore: asm2.evidenceStore,
      reader: asm2.reader,
      repo: repo2,
      turns: asm2.store.listTurns(session.id),
      finalFeedback: "",
      durationMs: asm2.store.sessionDuration(session.id),
    });
    expect(recap).toContain(
      "src/index.ts → src/parse/task.ts → src/parse/validate.ts → src/store/memory.ts → src/render/format.ts",
    );
  });
});

function makeRunner(
  asm: SessionAssembly,
  repo: Repository,
  sessionId: string,
  streams: ReturnType<typeof capturedStreams>,
): SessionRunner {
  const target = { sink: null };
  const { orchestrator } = asm.buildOrchestrator(repo, sessionId, "goal", (event) =>
    target.sink?.push(event),
  );
  return new SessionRunner({
    orchestrator,
    store: asm.store,
    sessionId,
    stdout: streams.stdout,
    stderr: streams.stderr,
    prompt: async () => "",
    target,
  });
}
