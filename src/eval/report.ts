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

  appendRunValidity(lines, report);
  appendLiveSession(lines, report.run, metrics);
  lines.push("");
  appendJudgeMode(lines, report.judge);

  return `${lines.join("\n")}\n`;
}

/**
 * A degraded or errored run must never read as a clean one: its metrics
 * (especially the near-zero repeated reads and lower tool-call counts a failed
 * run produces) are not comparable and would otherwise look like an
 * improvement. Flag it prominently instead of burying it in the `ended` line.
 */
function appendRunValidity(lines: string[], report: EvalReport): void {
  const reason = invalidRunReason(report);
  if (reason === null) {
    return;
  }
  lines.push("INVALID RUN");
  lines.push(`This session ${reason}; its metric numbers are not comparable.`);
  lines.push("Re-run before drawing conclusions.");
  lines.push("");
}

function appendLiveSession(lines: string[], run: EvalRun, metrics: ReportMetrics): void {
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
  appendInstrumentation(lines, run);

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

/**
 * The three instrumented counts (tool calls, repeated reads, carried bytes).
 * They are counts, not ratios, so there is no "not evaluable" state — an empty
 * run just shows 0 and is marked invalid rather than faking a number.
 */
function appendInstrumentation(lines: string[], run: EvalRun): void {
  const invalid = run.turns.length === 0;
  const suffix = invalid ? " (run invalid)" : "";

  const totalCalls = Object.values(run.toolCalls).reduce((sum, count) => sum + count, 0);
  const callList = Object.entries(run.toolCalls)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");
  lines.push(
    `Tool calls           ${totalCalls === 0 ? "0" : `${callList} (${totalCalls} total)`}${suffix}`,
  );
  lines.push(`Repeated reads       ${run.repeatedReads}${suffix}`);

  const carried = run.carriedBytes.reduce((sum, bytes) => sum + bytes, 0);
  let carriedDetail = String(carried);
  if (!invalid && run.carriedBytes.length > 0) {
    carriedDetail = `${carried} across ${run.carriedBytes.length} turn(s): ${run.carriedBytes.join(", ")}`;
  } else if (!invalid) {
    carriedDetail = `${carried} (no carry)`;
  }
  lines.push(`Carried bytes        ${carriedDetail}${suffix}`);
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

/**
 * Why a run cannot serve as an A/B comparison arm; null when it is clean.
 * A degraded recap (salvaged after the agent failed to decide) or an `error`
 * phase produces near-zero repeated reads and lower call counts for reasons
 * unrelated to the optimisation, so it must never be presented as a result.
 */
function invalidRunReason(report: EvalReport): string | null {
  if (report.endedPhase === "error") {
    return "ended in error (the agent produced no valid decision)";
  }
  if (report.degraded) {
    return "was degraded (the agent failed to decide; the recap was salvaged)";
  }
  return null;
}

/**
 * Whether the two arms of an A/B comparison are both valid (non-degraded and
 * ending in `recap`). When invalid, `reason` names each offending arm and why.
 */
export function abComparisonValidity(
  off: EvalReport,
  on: EvalReport,
): { valid: boolean; reason: string | null } {
  const offReason = invalidRunReason(off);
  const onReason = invalidRunReason(on);
  const reasons: string[] = [];
  if (offReason !== null) {
    reasons.push(`carry OFF run ${offReason}`);
  }
  if (onReason !== null) {
    reasons.push(`carry ON run ${onReason}`);
  }
  return reasons.length === 0
    ? { valid: true, reason: null }
    : { valid: false, reason: reasons.join("; ") };
}

/**
 * Side-by-side comparison of the "carry off" vs "carry on" arms of the #25
 * optimisation. Refuses to render the table when either arm is not a clean
 * (non-degraded, `recap`) run — a failed arm's 0 repeated reads would otherwise
 * read as an optimisation win. Only the quantities that matter for the
 * comparison are shown; the note below the table makes clear that token counts
 * are high-variance and repeatedReads is the primary signal.
 */
export function renderAbComparison(off: EvalReport, on: EvalReport): string {
  const validity = abComparisonValidity(off, on);
  if (!validity.valid) {
    return renderAbNotEvaluable(validity.reason ?? "unknown reason");
  }

  const offRun = off.run;
  const onRun = on.run;
  const offCalls = Object.values(offRun.toolCalls).reduce((sum, n) => sum + n, 0);
  const onCalls = Object.values(onRun.toolCalls).reduce((sum, n) => sum + n, 0);
  const offCarried = offRun.carriedBytes.reduce((sum, b) => sum + b, 0);
  const onCarried = onRun.carriedBytes.reduce((sum, b) => sum + b, 0);

  const header = ["metric", "carry OFF", "carry ON"];
  const rows: string[][] = [
    ["repeatedReads", String(offRun.repeatedReads), String(onRun.repeatedReads)],
    ["toolCalls (total)", String(offCalls), String(onCalls)],
    ["input tokens", String(offRun.usage.inputTokens), String(onRun.usage.inputTokens)],
    ["wall clock (ms)", String(offRun.wallClockMs), String(onRun.wallClockMs)],
    ["carried bytes", String(offCarried), String(onCarried)],
  ];
  const widths = [0, 1, 2].map((i) =>
    Math.max(header[i]!.length, ...rows.map((row) => row[i]!.length)),
  );
  const pad = (cell: string, i: number): string => cell.padEnd(widths[i]!);

  const lines: string[] = [];
  lines.push("RepoCoach Eval A/B (carry off vs carry on)");
  lines.push("=".repeat(58));
  lines.push(`${pad(header[0]!, 0)}  ${pad(header[1]!, 1)}  ${pad(header[2]!, 2)}`.trimEnd());
  lines.push("-".repeat(58));
  for (const row of rows) {
    lines.push(`${pad(row[0]!, 0)}  ${pad(row[1]!, 1)}  ${pad(row[2]!, 2)}`.trimEnd());
  }
  lines.push("");
  lines.push(
    "Note: real-model input/output token totals vary widely between runs",
  );
  lines.push(
    "(measured 137k-212k, ~35%), so the token row is NOT a reliable",
  );
  lines.push(
    "before/after signal. repeatedReads is the primary metric here — it",
  );
  lines.push(
    "counts content-returning re-reads of the same (path, range) across turns,",
  );
  lines.push(
    "the exact waste this optimisation removes.",
  );
  return `${lines.join("\n")}\n`;
}

/** The refusal message when one or both A/B arms are not valid runs. */
function renderAbNotEvaluable(reason: string): string {
  const lines = [
    "RepoCoach Eval A/B (carry off vs carry on)",
    "=".repeat(58),
    `Not evaluable: ${reason}.`,
    "A failed or degraded run is not evidence — re-run the arms before comparing.",
  ];
  return `${lines.join("\n")}\n`;
}
