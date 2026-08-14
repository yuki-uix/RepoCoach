/**
 * Eval report — machine-readable JSON + human-readable table.
 *
 * The JSON form is the stable artifact compared across runs (e.g. before/after
 * the #25 cost work); the human form is the terminal table. The JSON carries
 * the full `run` (every turn's question / answer / assessment / evidence plus
 * the session usage) so a disagreement can be diagnosed after the fact — the
 * answer-pairing bug shipped because the report never showed which question the
 * model actually asked. The human table stays concise and only surfaces the
 * metric summaries, failure lists and disagreements. Every interpolated value
 * in the human table is model- or fixture-sourced (untrusted) and so goes
 * through the same terminal-sanitization gate as the rest of the CLI
 * (docs/architecture.md §6): paths/names via `renderInline`, flowing reasons
 * and questions via `neutralizeMarkdown`.
 */

import { writeFileSync } from "node:fs";
import { neutralizeMarkdown, renderInline } from "../cli/markdown.js";
import { ASSESSMENT_LABELS, MODEL_ASSESSMENT_LABELS } from "./judge.js";
import type { ConfusionMatrix, JudgeResult } from "./judge.js";
import type {
  AdaptationResult,
  CostResult,
  HallucinationResult,
  PathAccuracyResult,
  PrecisionResult,
} from "./metrics.js";
import type { EvalRun } from "./types.js";

export type EvalMode = "mock" | "real";

/** The five live-session metrics (assessment agreement lives in judge mode). */
export interface ReportMetrics {
  evidencePrecision: PrecisionResult;
  pathAccuracy: PathAccuracyResult;
  adaptation: AdaptationResult;
  hallucination: HallucinationResult;
  cost: CostResult;
}

export interface EvalReport {
  mode: EvalMode;
  repositoryPath: string;
  featureId: string;
  featureGoal: string;
  endedPhase: string;
  degraded: boolean;
  /** The complete live session, kept in full for post-hoc diagnosis. */
  run: EvalRun;
  metrics: ReportMetrics;
  /** Isolated assessment-agreement measurement (src/eval/judge.ts). */
  judge: JudgeResult;
}

export function buildReport(input: {
  mode: EvalMode;
  run: EvalRun;
  metrics: ReportMetrics;
  judge: JudgeResult;
}): EvalReport {
  return {
    mode: input.mode,
    repositoryPath: input.run.repositoryPath,
    featureId: input.run.featureId,
    featureGoal: input.run.featureGoal,
    endedPhase: input.run.endedPhase,
    degraded: input.run.degraded,
    run: input.run,
    metrics: input.metrics,
    judge: input.judge,
  };
}

/** Serialize the stable JSON form (for before/after comparison). */
export function serializeReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function writeReport(report: EvalReport, path: string): void {
  writeFileSync(path, serializeReport(report), "utf8");
}

/** Render the human-readable table to stdout. */
export function renderReport(report: EvalReport): string {
  const metrics = report.metrics;
  const lines: string[] = [];
  lines.push(`RepoCoach Eval Report (${report.mode})`);
  lines.push("=".repeat(58));
  lines.push(`repository: ${renderInline(report.repositoryPath)}`);
  lines.push(`feature:    ${renderInline(report.featureId)} — ${neutralizeMarkdown(report.featureGoal)}`);
  lines.push(`ended:      ${renderInline(report.endedPhase)}${report.degraded ? " (degraded)" : ""}`);
  lines.push("");

  appendLiveSession(lines, metrics);
  lines.push("");
  appendJudgeMode(lines, report.judge);

  return `${lines.join("\n")}\n`;
}

function appendLiveSession(lines: string[], metrics: ReportMetrics): void {
  lines.push("Live session (evidence-grounded questioning)");
  lines.push("-".repeat(58));
  lines.push(
    "Measures the real question→answer→evidence loop. Assessment agreement is NOT",
  );
  lines.push("scored here — it is measured in judge mode below.");
  const precision = metrics.evidencePrecision;
  const notApplicableSuffix =
    precision.notApplicable > 0 ? `  (${precision.notApplicable} not applicable)` : "";
  lines.push(
    `Evidence precision   ${precision.supported} / ${precision.total}  ${ratioDisplay(precision.evaluable, precision.precision)}${notApplicableSuffix}`,
  );
  lines.push(
    `Path accuracy        ${metrics.pathAccuracy.matched} / ${metrics.pathAccuracy.total}  ${ratioDisplay(metrics.pathAccuracy.evaluable, metrics.pathAccuracy.accuracy)}`,
  );
  appendAdaptation(lines, metrics.adaptation);
  lines.push(
    `Hallucination        ${metrics.hallucination.missingCount} missing / ${metrics.hallucination.total} mentioned  ${ratioDisplay(metrics.hallucination.evaluable, metrics.hallucination.ratio)}`,
  );
  lines.push(
    `Cost                 ${metrics.cost.inputTokens} in / ${metrics.cost.outputTokens} out tokens, ${metrics.cost.wallClockMs}ms`,
  );

  if (precision.failures.length > 0) {
    lines.push("");
    lines.push("Evidence precision failures:");
    for (const failure of precision.failures) {
      lines.push(
        `  - ${renderInline(failure.path)}:${failure.startLine}-${failure.endLine} missing ${failure.missing.map(renderInline).join(", ")} — ${neutralizeMarkdown(failure.reason)}`,
      );
    }
  }

  if (precision.notApplicableDetails.length > 0) {
    lines.push("");
    lines.push("Evidence precision not applicable (no symbol claimed):");
    for (const item of precision.notApplicableDetails) {
      lines.push(
        `  - ${renderInline(item.path)}:${item.startLine}-${item.endLine} — ${neutralizeMarkdown(item.reason)}`,
      );
    }
  }

  if (metrics.hallucination.missing.length > 0) {
    lines.push("");
    lines.push("Hallucinated (not found in source):");
    for (const name of metrics.hallucination.missing) {
      lines.push(`  - ${renderInline(name)}`);
    }
  }
}

function appendJudgeMode(lines: string[], judge: JudgeResult): void {
  lines.push("Judge mode (isolated assessment agreement)");
  lines.push("-".repeat(58));
  lines.push(
    "Feeds each annotated (question, answer) to the judging function verbatim, so",
  );
  lines.push("the model never generates its own question here.");
  lines.push(
    `Assessment agreement ${judge.agreed} / ${judge.total}  ${ratioDisplay(judge.evaluable, judge.agreement)}`,
  );

  if (judge.disagreements.length > 0) {
    lines.push("");
    lines.push("Assessment disagreements:");
    for (const disagreement of judge.disagreements) {
      lines.push(
        `  - ${questionPair(disagreement.annotatedQuestion, disagreement.modelQuestion)}: expected ${renderInline(disagreement.expected)}, got ${renderInline(disagreement.actual)}`,
      );
    }
  }

  if (judge.total > 0) {
    lines.push("");
    lines.push("Assessment confusion (annotation × model):");
    appendConfusionMatrix(lines, judge.confusion);
    lines.push(
      "Note: annotations are pre-authored in fixtures/expectations/answer-samples.json; a persistent systematic bias may mean the annotations need review, not that the model is unfit.",
    );
  }
}

/**
 * Show the annotated question and the question the model actually saw. They are
 * identical by construction in judge mode, so this normally prints one line;
 * if they ever diverge, both are shown explicitly rather than silently
 * comparing against the wrong question.
 */
function questionPair(annotated: string, model: string): string {
  if (annotated === model) {
    return neutralizeMarkdown(annotated);
  }
  return `annotated "${neutralizeMarkdown(annotated)}" ≠ model saw "${neutralizeMarkdown(model)}"`;
}

/** Append an aligned annotation × model count table. */
function appendConfusionMatrix(lines: string[], confusion: ConfusionMatrix): void {
  const header = ["annotation", ...MODEL_ASSESSMENT_LABELS];
  const rows = ASSESSMENT_LABELS.map((label) => [
    label,
    ...MODEL_ASSESSMENT_LABELS.map((column) => String(confusion[label]?.[column] ?? 0)),
  ]);
  const table = [header, ...rows];
  const widths = header.map((cell, index) => {
    let width = cell.length;
    for (const row of table) {
      width = Math.max(width, row[index].length);
    }
    return width;
  });
  for (const row of table) {
    const line = row.map((cell, index) => cell.padEnd(widths[index])).join(" ");
    lines.push(`  ${line.trimEnd()}`);
  }
}

function percent(ratio: number): string {
  return `(${(ratio * 100).toFixed(1)}%)`;
}

/**
 * `(X%)` when the denominator was non-empty, else `not evaluable` — a
 * degenerate input must never render as 0% or 100%.
 */
function ratioDisplay(evaluable: boolean, value: number | undefined): string {
  return evaluable && value !== undefined ? percent(value) : "not evaluable";
}

/**
 * Adaptation never renders "adapted"/"not adapted" when there was no follow-up
 * question on either side; it reports why the comparison could not be made.
 */
function appendAdaptation(lines: string[], adaptation: AdaptationResult): void {
  if (adaptation.evaluable && adaptation.adapted !== undefined && adaptation.jaccard !== undefined) {
    lines.push(
      `Adaptation           ${adaptation.adapted ? "adapted" : "not adapted"}  (jaccard ${adaptation.jaccard.toFixed(3)})`,
    );
    return;
  }
  lines.push(`Adaptation           not evaluable (${adaptation.reason ?? "no follow-up question"})`);
}
