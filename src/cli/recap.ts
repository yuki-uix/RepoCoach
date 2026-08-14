/**
 * Session recap rendering.
 *
 * Covers every mvp-spec §5.4 entry: the feature call chain (evidence paths in
 * appearance order), key modules and responsibilities, what the learner got
 * right, the concepts they confused, the important source evidence with
 * context, likely interviewer follow-ups, and recommended next steps — plus
 * the session duration. See docs/mvp-spec.md §5.4.
 */

import type { Evidence, LearningTurn } from "../domain/index.js";
import type { EvidenceStore } from "../evidence/index.js";
import type { Reader, Repository } from "../reader/index.js";
import { codeBlock, neutralizeMarkdown } from "./markdown.js";

export interface RecapDeps {
  sessionId: string;
  evidenceStore: EvidenceStore;
  reader: Reader;
  repo: Repository;
  turns: LearningTurn[];
  /** The closing decision's feedback (follow-up questions + next steps). */
  finalFeedback: string;
  durationMs: number;
}

/**
 * Collect grounded evidence for a session. The in-memory EvidenceStore is the
 * live source, but it does not survive a resume — turns persist their evidence
 * in the session file, so merge both and let the dedup collapse the overlap.
 */
export function collectEvidence(
  evidenceStore: EvidenceStore,
  turns: LearningTurn[],
  sessionId: string,
): Evidence[] {
  const fromStore = evidenceStore.listBySession(sessionId).map((record) => record.evidence);
  const fromTurns = turns.flatMap((turn) => turn.evidence);
  return [...fromStore, ...fromTurns];
}

/** Deduplicate evidence by (path, line range), preserving first-seen order. */
export function dedupeEvidence(records: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const record of records) {
    const key = `${record.path}:${record.startLine}-${record.endLine}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(record);
  }
  return out;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/** Last non-empty feedback across the turns (the closing decision's feedback). */
export function lastFeedback(turns: LearningTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const feedback = turns[i]?.feedback;
    if (feedback !== undefined && feedback !== "") {
      return feedback;
    }
  }
  return "";
}

/** Split the closing feedback into follow-up questions and next steps. */
export function splitFeedback(feedback: string): {
  followUp: string;
  nextSteps: string;
} {
  const marker = "Next steps:";
  const index = feedback.indexOf(marker);
  if (index === -1) {
    return { followUp: feedback, nextSteps: "" };
  }
  const followUp = stripLabel(feedback.slice(0, index), "Follow-up questions:");
  const nextSteps = feedback.slice(index + marker.length).trim();
  return { followUp, nextSteps };
}

export function renderRecap(deps: RecapDeps): string {
  const records = dedupeEvidence(
    collectEvidence(deps.evidenceStore, deps.turns, deps.sessionId),
  );
  const sections: string[] = [];

  sections.push("## 功能调用链");
  sections.push(
    records.length === 0 ? "(无接地证据)" : records.map((record) => record.path).join(" → "),
  );

  sections.push("## 关键模块及职责");
  if (records.length === 0) {
    sections.push("(无)");
  } else {
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.path)) {
        continue;
      }
      seen.add(record.path);
      sections.push(`${record.path} — ${neutralizeMarkdown(record.reason)}`);
    }
  }

  sections.push("## 你答对的部分");
  const correct = assessedItems(deps.turns).filter(
    (item) => item.assessment === "correct",
  );
  sections.push(
    ...(correct.length === 0
      ? ["(无)"]
      : correct.map((item) => renderAssessedItem(item))),
  );

  sections.push("## 你混淆的概念");
  const confused = assessedItems(deps.turns).filter(
    (item) => item.assessment === "partial" || item.assessment === "incorrect",
  );
  sections.push(
    ...(confused.length === 0
      ? ["(无)"]
      : confused.map((item) => renderAssessedItem(item))),
  );

  sections.push("## 重要源码证据");
  if (records.length === 0) {
    sections.push("(无)");
  } else {
    for (const record of records) {
      const context = deps.evidenceStore.getSourceContext(record, deps.reader, deps.repo);
      sections.push(
        `${record.path}:${record.startLine}-${record.endLine} — ${neutralizeMarkdown(record.reason)}`,
      );
      sections.push(codeBlock(context.content));
      sections.push("");
    }
  }

  const { followUp, nextSteps } = splitFeedback(deps.finalFeedback);
  sections.push("## 面试官可能追问");
  sections.push(followUp === "" ? "(无)" : neutralizeMarkdown(followUp));
  sections.push("## 推荐下一步");
  sections.push(nextSteps === "" ? "(无)" : neutralizeMarkdown(nextSteps));

  sections.push("## Session 总耗时");
  sections.push(formatDuration(deps.durationMs));

  return `${sections.join("\n").trimEnd()}\n`;
}

function stripLabel(text: string, label: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith(label) ? trimmed.slice(label.length).trim() : trimmed;
}

/** Render one assessed item with its (untrusted) question and feedback neutralized. */
function renderAssessedItem(item: AssessedItem): string {
  const question = neutralizeMarkdown(item.question);
  const feedback = item.feedback === undefined ? "" : ` — ${neutralizeMarkdown(item.feedback)}`;
  return `- ${question}${feedback}`;
}

interface AssessedItem {
  question: string;
  assessment: "correct" | "partial" | "incorrect";
  feedback?: string;
}

/**
 * Pair each assessed turn with the question it answers. The state machine
 * consumes an answer in one transition (hypothesis → trace) and records the
 * assessment in the next (trace → questioning), so the answer and its
 * assessment land on different turns; the most recent non-empty question is
 * the one the assessment refers to.
 */
function assessedItems(turns: LearningTurn[]): AssessedItem[] {
  const items: AssessedItem[] = [];
  let lastQuestion = "";
  for (const turn of turns) {
    if (turn.question !== undefined && turn.question.trim() !== "") {
      lastQuestion = turn.question.trim();
    }
    if (
      turn.assessment === "correct" ||
      turn.assessment === "partial" ||
      turn.assessment === "incorrect"
    ) {
      items.push({
        question: lastQuestion,
        assessment: turn.assessment,
        feedback: turn.feedback,
      });
    }
  }
  return items;
}
