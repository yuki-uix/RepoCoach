import { describe, expect, it } from "vitest";
import {
  codeBlock,
  escapeFences,
  escapeHeadings,
  formatEvidence,
  neutralizeMarkdown,
  renderDecision,
  renderQuestion,
  renderRecap,
} from "../../src/cli";
import type { Evidence, LearningTurn } from "../../src/domain";
import type { EvidenceStore } from "../../src/evidence";
import type { Reader, Repository } from "../../src/reader";

describe("escapeHeadings", () => {
  it("backslash-escapes a leading hash run followed by whitespace", () => {
    expect(escapeHeadings("## 假段落")).toBe("\\#\\# 假段落");
    expect(escapeHeadings("# 标题")).toBe("\\# 标题");
    expect(escapeHeadings("### x")).toBe("\\#\\#\\# x");
  });

  it("neutralizes headings indented up to three spaces (CommonMark)", () => {
    expect(escapeHeadings("   ## indented")).toBe("   \\#\\# indented");
    // Four spaces is a code block, not a heading — leave it alone.
    expect(escapeHeadings("    ## code block")).toBe("    ## code block");
  });

  it("leaves non-heading hash runs alone", () => {
    expect(escapeHeadings("##NoSpace")).toBe("##NoSpace");
    expect(escapeHeadings("####### seven hashes")).toBe("####### seven hashes");
  });
});

describe("escapeFences", () => {
  it("backslash-escapes runs of three or more backticks", () => {
    expect(escapeFences("```")).toBe("\\`\\`\\`");
    expect(escapeFences("````")).toBe("\\`\\`\\`\\`");
  });

  it("leaves inline-code backticks (one or two) alone", () => {
    expect(escapeFences("`inline` and ``double``")).toBe("`inline` and ``double``");
  });
});

describe("neutralizeMarkdown", () => {
  it("neutralizes headings and fences together", () => {
    const out = neutralizeMarkdown("## 假段落\n```\ncode\n```");
    expect(out).toBe("\\#\\# 假段落\n\\`\\`\\`\ncode\n\\`\\`\\`");
  });
});

describe("codeBlock", () => {
  it("wraps content in a fence and escapes internal fences", () => {
    expect(codeBlock("## heading\n```\ncode\n```")).toBe(
      "```\n## heading\n\\`\\`\\`\ncode\n\\`\\`\\`\n```",
    );
  });
});

describe("recap markdown neutralization", () => {
  const EVIDENCE: Evidence = {
    path: "src/index.ts",
    startLine: 1,
    endLine: 3,
    reason: "# 标题 forged reason",
  };
  const SOURCE_CONTENT = "```\nconst x = 1;\n```";

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

  it("escapes forged headings and fences in feedback, reason and source", () => {
    const out = recap();
    // Feedback headings/fences and the evidence reason are neutralized…
    expect(out).toContain("\\#\\# 假段落");
    expect(out).toContain("\\#\\# 假追问");
    expect(out).toContain("\\# 标题 forged reason");
    // …and the source context's own fence is escaped inside our code block.
    expect(out).toContain("\\`\\`\\`");
  });
});

describe("session-runner markdown neutralization", () => {
  it("neutralizes the question", () => {
    const out = renderQuestion("## 假问题");
    expect(out).toContain("\\#\\# 假问题");
    expect(out).not.toContain("## 假问题");
  });

  it("neutralizes mid-session feedback", () => {
    const out = renderDecision(
      { evidence: [], nextAction: "ask", feedback: "# 假反馈" },
      false,
    );
    expect(out).toContain("\\# 假反馈");
    expect(out).not.toMatch(/^# 假反馈/m);
  });

  it("neutralizes evidence reason in formatEvidence", () => {
    const out = formatEvidence({
      path: "src/a.ts",
      startLine: 1,
      endLine: 2,
      reason: "## 假证据",
    });
    expect(out).toBe("src/a.ts:1-2 — \\#\\# 假证据");
  });
});
