/**
 * Eval report — machine-readable JSON + human-readable table.
 *
 * The JSON form is the stable artifact compared across runs (e.g. before/after
 * the #25 cost work); the human form is the terminal table. Every interpolated
 * value in the human table is model- or fixture-sourced (untrusted) and so goes
 * through the same terminal-sanitization gate as the rest of the CLI
 * (docs/architecture.md §6): paths/names via `renderInline`, flowing reasons
 * and questions via `neutralizeMarkdown`.
 */

import { writeFileSync } from "node:fs";
import { neutralizeMarkdown, renderInline } from "../cli/markdown.js";
import type { EvalRun } from "./types.js";
import type {
  AdaptationResult,
  AssessmentAgreementResult,
  CostResult,
  HallucinationResult,
  PathAccuracyResult,
  PrecisionResult,
} from "./metrics.js";

export type EvalMode = "mock" | "real";

export interface ReportMetrics {
  evidencePrecision: PrecisionResult;
  pathAccuracy: PathAccuracyResult;
  assessmentAgreement: AssessmentAgreementResult;
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
  metrics: ReportMetrics;
}

export function buildReport(input: {
  mode: EvalMode;
  run: EvalRun;
  metrics: ReportMetrics;
}): EvalReport {
  return {
    mode: input.mode,
    repositoryPath: input.run.repositoryPath,
    featureId: input.run.featureId,
    featureGoal: input.run.featureGoal,
    endedPhase: input.run.endedPhase,
    degraded: input.run.degraded,
    metrics: input.metrics,
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
  lines.push(
    `Evidence precision   ${metrics.evidencePrecision.supported} / ${metrics.evidencePrecision.total}  ${percent(metrics.evidencePrecision.precision)}`,
  );
  lines.push(
    `Path accuracy        ${metrics.pathAccuracy.matched} / ${metrics.pathAccuracy.total}  ${percent(metrics.pathAccuracy.accuracy)}`,
  );
  lines.push(
    `Assessment agreement ${metrics.assessmentAgreement.agreed} / ${metrics.assessmentAgreement.matched}  ${percent(metrics.assessmentAgreement.agreement)}`,
  );
  lines.push(
    `Adaptation           ${metrics.adaptation.adapted ? "adapted" : "not adapted"}  (jaccard ${metrics.adaptation.jaccard.toFixed(3)})`,
  );
  lines.push(
    `Hallucination        ${metrics.hallucination.missingCount} missing / ${metrics.hallucination.total} mentioned  ${percent(metrics.hallucination.ratio)}`,
  );
  lines.push(
    `Cost                 ${metrics.cost.inputTokens} in / ${metrics.cost.outputTokens} out tokens, ${metrics.cost.wallClockMs}ms`,
  );

  if (metrics.evidencePrecision.failures.length > 0) {
    lines.push("");
    lines.push("Evidence precision failures:");
    for (const failure of metrics.evidencePrecision.failures) {
      const missing =
        failure.missing.length === 0
          ? "(no symbol claimed)"
          : failure.missing.map(renderInline).join(", ");
      lines.push(
        `  - ${renderInline(failure.path)}:${failure.startLine}-${failure.endLine} missing ${missing} — ${neutralizeMarkdown(failure.reason)}`,
      );
    }
  }

  if (metrics.assessmentAgreement.disagreements.length > 0) {
    lines.push("");
    lines.push("Assessment disagreements:");
    for (const disagreement of metrics.assessmentAgreement.disagreements) {
      lines.push(
        `  - ${neutralizeMarkdown(disagreement.question)}: expected ${renderInline(disagreement.expected)}, got ${renderInline(disagreement.actual)}`,
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

  return `${lines.join("\n")}\n`;
}

function percent(ratio: number): string {
  return `(${(ratio * 100).toFixed(1)}%)`;
}
