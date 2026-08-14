import { describe, expect, it } from "vitest";
import { assembleSession, runCli, SessionRunner } from "../../src/cli";
import { JsonSessionStore } from "../../src/store";
import {
  EVIDENCE,
  PREDICTION_Q,
  capturedStreams,
  fixtureRoot,
  fullSessionScript,
  makeDataDir,
  scriptedProvider,
  toolMessage,
} from "./helpers";

/** stdin lines: candidate choice, prediction answer, follow-up answer, self-assessment. */
const STDIN =
  "1\n" +
  "parseTask parses it, validate checks it, store.add saves it, formatTask renders it.\n" +
  "parseTask generates the id while splitting the string.\n" +
  "y\n";

describe("CLI start (end to end)", () => {
  it("drives a full start → recap session over the fixture (AC1/AC3)", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    streams.stdin.write(STDIN);

    const code = await runCli(["start", fixtureRoot], {
      dataDir,
      provider: scriptedProvider(fullSessionScript()),
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    streams.stdin.end();

    expect(code).toBe(0);
    const out = streams.stdoutText();

    // Candidate selection shown.
    expect(out).toContain("Task creation pipeline");
    // The prediction question and evidence display appear mid-session.
    expect(out).toContain(PREDICTION_Q);
    expect(out).toContain("src/index.ts:25-43 — createTracker wires parse → validate → store → render");

    // AC3 — every mvp-spec §5.4 entry is present.
    expect(out).toContain("## 功能调用链");
    expect(out).toContain(
      "src/index.ts → src/parse/task.ts → src/parse/validate.ts → src/store/memory.ts → src/render/format.ts",
    );

    expect(out).toContain("## 关键模块及职责");
    expect(out).toContain("src/store/memory.ts — MemoryStore.add assigns an id and stores the task");

    expect(out).toContain("## 你答对的部分");
    expect(out).toContain("Correct — you named the full parse → validate → store → render chain.");

    expect(out).toContain("## 你混淆的概念");
    expect(out).toContain("Ids are assigned by MemoryStore.add; parseTask only splits the string.");

    expect(out).toContain("## 重要源码证据");
    expect(out).toContain("src/render/format.ts:12-15 — formatTask renders the stored task back to a string");
    // Source context is fetched (the entry function name appears in the snippet).
    expect(out).toContain("createTracker");

    expect(out).toContain("## 面试官可能追问");
    expect(out).toContain("How does validate behave when a task has no assignee?");

    expect(out).toContain("## 推荐下一步");
    expect(out).toContain("Read src/util/format.ts and contrast it with src/render/format.ts.");

    expect(out).toContain("## Session 总耗时");
  });

  it("renders tool_call_started / tool_result lines to stderr (AC2)", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    const provider = scriptedProvider([
      toolMessage("c1", "repo_read_file", { path: "src/index.ts", startLine: 25, endLine: 43 }),
      toolMessage("c2", "submit_decision", { evidence: [], nextAction: "show_evidence" }),
    ]);

    const asm = assembleSession({
      dataDir,
      provider,
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    const repo = await asm.reader.importRepository(fixtureRoot);
    const session = asm.store.createSession({ repositoryId: fixtureRoot, featureId: "x" });
    const target = { sink: null };
    const { orchestrator } = asm.buildOrchestrator(
      repo,
      session.id,
      "goal",
      (event) => target.sink?.push(event),
    );
    const runner = new SessionRunner({
      orchestrator,
      store: asm.store,
      sessionId: session.id,
      stdout: streams.stdout,
      stderr: streams.stderr,
      prompt: async () => "",
      target,
    });

    await runner.advance();

    const err = streams.stderrText();
    expect(err).toContain("→ repo_read_file");
    expect(err).toContain("path=src/index.ts");
  });

  it("records the self-assessment as an extra turn", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();
    streams.stdin.write(STDIN);

    const store = new JsonSessionStore(dataDir);
    const code = await runCli(["start", fixtureRoot], {
      dataDir,
      store,
      provider: scriptedProvider(fullSessionScript()),
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    streams.stdin.end();

    expect(code).toBe(0);
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    const turns = store.listTurns(sessions[0]!.id);
    const selfAssessment = turns[turns.length - 1];
    expect(selfAssessment?.question).toBe("你现在能向别人复述这条链路吗？");
    expect(selfAssessment?.userAnswer).toBe("y");
    expect(selfAssessment?.evidence).toEqual([]);
    expect(EVIDENCE).toHaveLength(5);
  });
});
