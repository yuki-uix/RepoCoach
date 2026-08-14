import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli";
import type { LearningTurn } from "../../src/domain";
import { JsonSessionStore } from "../../src/store";
import { capturedStreams, makeDataDir } from "./helpers";

/** Every top-level ATX heading line in the rendered output. */
function topLevelHeadings(markdown: string): string[] {
  return markdown.split("\n").filter((line) => /^#{1,6} /.test(line));
}

describe("CLI show", () => {
  it("renders a persisted session's turns and all saved evidence", async () => {
    const dataDir = makeDataDir();
    const store = new JsonSessionStore(dataDir);
    const session = store.createSession({
      repositoryId: "https://github.com/acme/widget",
      featureId: "task-creation",
      workspacePath: "packages/core",
    });
    // A terminal session — the show command's whole reason to exist: `resume`
    // refuses it, but its persisted turns still hold evidence.
    store.updateSession(session.id, { phase: "error", status: "abandoned" });

    const turn1: LearningTurn = {
      sessionId: session.id,
      question: "Which module assigns the id?",
      userAnswer: "MemoryStore.add",
      evidence: [
        { path: "src/store/memory.ts", startLine: 17, endLine: 22, reason: "MemoryStore.add assigns an id" },
      ],
      assessment: "correct",
      feedback: "Correct.",
    };
    const turn2: LearningTurn = {
      sessionId: session.id,
      question: "Who validates the task?",
      userAnswer: "validate()",
      evidence: [
        { path: "src/parse/validate.ts", startLine: 24, endLine: 32, reason: "validate rejects empty titles" },
      ],
      assessment: "partial",
    };
    store.appendTurn(turn1);
    store.appendTurn(turn2);

    const streams = capturedStreams();
    const code = await runCli(["show", session.id], {
      dataDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    const out = streams.stdoutText();

    // Session metadata: repository, workspace, phase, status, duration.
    expect(out).toContain(`## Session ${session.id}`);
    expect(out).toContain("仓库: https://github.com/acme/widget");
    expect(out).toContain("Workspace: packages/core");
    expect(out).toContain("阶段: error");
    expect(out).toContain("状态: abandoned");
    expect(out).toContain("耗时:");

    // Each turn's question, answer and assessment.
    expect(out).toContain("Which module assigns the id?");
    expect(out).toContain("MemoryStore.add");
    expect(out).toContain("评估: correct");
    expect(out).toContain("Who validates the task?");
    expect(out).toContain("validate()");
    expect(out).toContain("评估: partial");

    // Every saved evidence line (path:startLine-endLine — reason).
    expect(out).toContain("src/store/memory.ts:17-22 — MemoryStore.add assigns an id");
    expect(out).toContain("src/parse/validate.ts:24-32 — validate rejects empty titles");
  });

  it("fails clearly with a non-zero exit for an unknown session", async () => {
    const dataDir = makeDataDir();
    const streams = capturedStreams();

    const code = await runCli(["show", "does-not-exist"], {
      dataDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(1);
    expect(streams.stderrText()).toContain("No session found: does-not-exist");
  });

  it("neutralizes forged headings/fences in questions and evidence reasons", async () => {
    const dataDir = makeDataDir();
    const store = new JsonSessionStore(dataDir);
    const session = store.createSession({ repositoryId: "repo", featureId: "f" });
    store.appendTurn({
      sessionId: session.id,
      question: "## 假段落\n```\nquestion fence\n```",
      userAnswer: "answer",
      evidence: [
        {
          path: "src/a.ts",
          startLine: 1,
          endLine: 2,
          reason: "## 假段落\n```\nreason fence\n```",
        },
      ],
      assessment: "correct",
    });

    const streams = capturedStreams();
    const code = await runCli(["show", session.id], {
      dataDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    const out = streams.stdoutText();

    // Only RepoCoach's own headings sit at column 0 — a forged `## 假段落` in
    // a question or reason must never become a top-level section heading.
    expect(topLevelHeadings(out)).toEqual([
      `## Session ${session.id}`,
      "## 对话记录",
      "### 第 1 轮",
      "## 已保存证据",
    ]);
    // The forged headings are neutralized (single leading space), not emitted raw.
    expect(out).toContain(" ## 假段落");
    expect(out).not.toMatch(/^## 假段落/m);
  });
});
