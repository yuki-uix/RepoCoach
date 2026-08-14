import { describe, expect, it } from "vitest";
import {
  formatEvidence,
  neutralizeMarkdown,
  renderDecision,
  renderQuestion,
  renderRecap,
  renderUntrustedBlock,
} from "../../src/cli";
import type { Evidence, LearningTurn } from "../../src/domain";
import type { EvidenceStore } from "../../src/evidence";
import type { Reader, Repository } from "../../src/reader";

describe("neutralizeMarkdown", () => {
  it("adds a single leading space before a column-0 heading hash run", () => {
    expect(neutralizeMarkdown("## 假段落")).toBe(" ## 假段落");
    expect(neutralizeMarkdown("# 标题")).toBe(" # 标题");
    expect(neutralizeMarkdown("### x")).toBe(" ### x");
  });

  it("neutralizes only the heading line, leaving other lines intact", () => {
    const out = neutralizeMarkdown("## 假段落\n```\ncode\n```");
    expect(out).toBe(" ## 假段落\n```\ncode\n```");
  });

  it("leaves non-heading hash runs alone", () => {
    expect(neutralizeMarkdown("##NoSpace")).toBe("##NoSpace");
    expect(neutralizeMarkdown("####### seven hashes")).toBe("####### seven hashes");
    expect(neutralizeMarkdown("   ## indented")).toBe("   ## indented");
  });

  it("introduces no backslash escape noise", () => {
    expect(neutralizeMarkdown("## 假段落\n```")).not.toContain("\\");
  });
});

describe("renderUntrustedBlock", () => {
  it("indents every line behind │ and dims the whole block", () => {
    const out = renderUntrustedBlock("## heading\n```\ncode\n```");
    expect(out).toContain("\x1b[2m");
    expect(out).toContain("\x1b[2m│ ## heading");
    expect(out).toContain("│ ```");
    expect(out).toContain("│ code");
    // No content line sits at column 0 — every one carries the prefix.
    expect(out).not.toContain("\n## heading");
    expect(out).not.toContain("\n```");
  });

  it("emits no backslash escape noise", () => {
    expect(renderUntrustedBlock("## heading\n```\ncode\n```")).not.toMatch(/\\[#`]/);
  });
});

describe("recap markdown neutralization", () => {
  const EVIDENCE: Evidence = {
    path: "src/index.ts",
    startLine: 1,
    endLine: 3,
    reason: "# 标题 forged reason",
  };
  const SOURCE_CONTENT = "## 假段落\n```\nconst x = 1;\n```";

  function fakeStore(): EvidenceStore {
    return {
      save: () => {},
      listBySession: () => [],
      getSourceContext: (evidence: Evidence) => ({
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        totalLines: 10,
        content: SOURCE_CONTENT,
      }),
    };
  }

  const TURNS: LearningTurn[] = [
    {
      sessionId: "s1",
      question: "Which module assigns the id?",
      userAnswer: "unknown",
      evidence: [EVIDENCE],
      assessment: "incorrect",
      feedback: "## 假段落\n```\nbad advice\n```",
    },
  ];

  const FINAL_FEEDBACK =
    "Follow-up questions:\n## 假追问\nNext steps:\n```\nstep\n```";

  function recap(): string {
    return renderRecap({
      sessionId: "s1",
      evidenceStore: fakeStore(),
      reader: undefined as unknown as Reader,
      repo: undefined as unknown as Repository,
      turns: TURNS,
      finalFeedback: FINAL_FEEDBACK,
      durationMs: 30_000,
    });
  }

  /** Every top-level ATX heading line in the rendered output. */
  function topLevelHeadings(markdown: string): string[] {
    return markdown.split("\n").filter((line) => /^#{1,6} /.test(line));
  }

  it("keeps only RepoCoach's own section headings at the top level", () => {
    expect(topLevelHeadings(recap())).toEqual([
      "## 功能调用链",
      "## 关键模块及职责",
      "## 你答对的部分",
      "## 你混淆的概念",
      "## 重要源码证据",
      "## 面试官可能追问",
      "## 推荐下一步",
      "## Session 总耗时",
    ]);
  });

  it("indents forged headings/fences in feedback, reason and source", () => {
    const out = recap();
    // Flowing untrusted text gets a leading space before a forged heading…
    expect(out).toContain(" # 标题 forged reason");
    expect(out).toContain("? —  ## 假段落");
    expect(out).toContain(" ## 假追问");
    // …and the source context block is indented behind the │ prefix, so its
    // heading and fence never sit at column 0.
    expect(out).toContain("│ ## 假段落");
    expect(out).toContain("│ ```");
    expect(out).toContain("│ const x = 1;");
  });

  it("emits no backslash escape noise anywhere", () => {
    expect(recap()).not.toMatch(/\\[#`]/);
  });
});

describe("session-runner markdown neutralization", () => {
  it("neutralizes the question", () => {
    const out = renderQuestion("## 假问题");
    expect(out).toContain(" ## 假问题");
    expect(out).not.toContain("\n## 假问题");
  });

  it("neutralizes mid-session feedback", () => {
    const out = renderDecision(
      { evidence: [], nextAction: "ask", feedback: "# 假反馈" },
      false,
    );
    expect(out).toContain(" # 假反馈");
    expect(out).not.toMatch(/^# 假反馈/m);
  });

  it("neutralizes evidence reason in formatEvidence", () => {
    const out = formatEvidence({
      path: "src/a.ts",
      startLine: 1,
      endLine: 2,
      reason: "## 假证据",
    });
    expect(out).toBe("src/a.ts:1-2 —  ## 假证据");
  });
});
