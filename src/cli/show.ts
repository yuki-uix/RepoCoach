/**
 * `repocoach show` rendering — the persisted view of one session.
 *
 * A terminal-phase session (error / abandoned / degraded) cannot be resumed,
 * but the turns it already persisted may still hold useful grounded evidence.
 * This renders that persisted content — session metadata, each turn's question,
 * answer and assessment, and every saved evidence record — so a learner whose
 * session ended badly can still read what the model surfaced (issue #23's
 * premise: no saved work should become unreachable).
 *
 * Every untrusted (model- or repo-derived) field — question, answer, feedback,
 * evidence reason — passes through the same `neutralizeMarkdown` /
 * `formatEvidence` gate as recap and session-runner, and structured fields
 * (path, repository id, workspace path, session id, phase, status) go through
 * `renderInline` so a multi-line value can never break out of a single-line
 * slot (docs/architecture.md §6 "同一道闸覆盖所有出口"); none is rendered raw.
 */

import type { LearningSession, LearningTurn } from "../domain/index.js";
import { neutralizeMarkdown, renderInline } from "./markdown.js";
import { dedupeEvidence, formatDuration } from "./recap.js";
import { formatEvidence } from "./session-runner.js";

export interface ShowDeps {
  session: LearningSession;
  turns: LearningTurn[];
  durationMs: number;
}

export function renderSessionShow(deps: ShowDeps): string {
  const { session, turns, durationMs } = deps;
  const lines: string[] = [];

  lines.push(`## Session ${renderInline(session.id)}`);
  lines.push(`仓库: ${renderInline(session.repositoryId)}`);
  if (session.workspacePath !== undefined) {
    lines.push(`Workspace: ${renderInline(session.workspacePath)}`);
  }
  lines.push(`阶段: ${renderInline(session.phase)}`);
  lines.push(`状态: ${renderInline(session.status)}`);
  lines.push(`耗时: ${formatDuration(durationMs)}`);
  lines.push("");

  lines.push("## 对话记录");
  if (turns.length === 0) {
    lines.push("(无)");
  } else {
    turns.forEach((turn, index) => {
      lines.push(`### 第 ${index + 1} 轮`);
      lines.push(`问题: ${neutralizeMarkdown(turn.question)}`);
      lines.push(renderAnswer(turn));
      if (turn.assessment !== undefined) {
        lines.push(`评估: ${renderInline(turn.assessment)}`);
      }
      if (turn.feedback !== undefined && turn.feedback !== "") {
        lines.push(`反馈: ${neutralizeMarkdown(turn.feedback)}`);
      }
      lines.push("");
    });
  }

  const evidence = dedupeEvidence(turns.flatMap((turn) => turn.evidence));
  lines.push("## 已保存证据");
  if (evidence.length === 0) {
    lines.push("(无)");
  } else {
    for (const record of evidence) {
      lines.push(formatEvidence(record));
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderAnswer(turn: LearningTurn): string {
  if (turn.userAnswer !== undefined && turn.userAnswer !== "") {
    return `回答: ${neutralizeMarkdown(turn.userAnswer)}`;
  }
  return turn.skipped === true ? "回答: (跳过)" : "回答: (未回答)";
}
