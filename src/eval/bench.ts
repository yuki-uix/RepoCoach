/**
 * Benchmark mode — a repeatable cost comparison over a real repository.
 *
 * Each benchmark pins a repository to a commit SHA and a feature to a fixed
 * (featureId, featureGoal, entryFiles) triple plus scripted learner answers, so
 * every run of the benchmark explores the same code path. `runBench` runs the
 * benchmark N times through the REAL assembly (`runEvalSession`) and reports
 * the median with a (min–max) spread per metric, so a single outlier run stays
 * visible instead of dragging an average.
 *
 * This is deliberately NOT in CI: every run is a real model call that spends
 * real money. It is a manually-triggered before/after tool — run it once before
 * a change and once after, then diff the two JSON reports.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChatProvider } from "../agent/provider.js";
import type { Repository } from "../reader/index.js";
import { DEFAULT_DEEPSEEK_MODEL, DeepSeekProvider } from "../agent/index.js";
import { loadConfig } from "../config.js";
import { assembleSession, type SessionAssembly } from "../cli/assemble.js";
import { splitRepositoryId } from "../cli/index.js";
import { neutralizeMarkdown, renderInline } from "../cli/markdown.js";
import { spread, type Spread } from "./benchmark-stats.js";
import { loadBenchmarks, type Benchmark } from "./benchmarks.js";
import { runEvalSession } from "./runner.js";
import type { EvalEndPhase, EvalRun } from "./types.js";

/** The per-run raw values a benchmark reports. Every field is a plain number or a count map. */
export interface BenchRunMetrics {
  completedQuestions: number;
  inputTokens: number;
  outputTokens: number;
  providerCalls: number;
  toolCalls: Record<string, number>;
  peakRequestBytes: number;
  toolResultBytes: number;
  compressibleBytes: number;
}

/** The fixed (non-tool) metric keys, in the order the table renders them. */
export type BenchMetricKey =
  | "completedQuestions"
  | "inputTokens"
  | "outputTokens"
  | "providerCalls"
  | "peakRequestBytes"
  | "toolResultBytes"
  | "compressibleBytes";

export interface BenchMetricSummaries {
  completedQuestions: Spread;
  inputTokens: Spread;
  outputTokens: Spread;
  providerCalls: Spread;
  peakRequestBytes: Spread;
  toolResultBytes: Spread;
  compressibleBytes: Spread;
}

export interface BenchSectionSummary {
  metrics: BenchMetricSummaries;
  /** Per-tool-name call-count spreads (union of tool names across runs). */
  toolCalls: Record<string, Spread>;
}

/** One raw run kept in the JSON so any statistic can be recomputed later. */
export interface BenchRunEntry {
  /** 1-based run index within its benchmark. */
  run: number;
  endedPhase: EvalEndPhase;
  degraded: boolean;
  metrics: BenchRunMetrics;
}

export interface BenchSection {
  name: string;
  repositoryId: string;
  featureId: string;
  featureGoal: string;
  runs: BenchRunEntry[];
  summary: BenchSectionSummary;
}

export interface BenchReport {
  runsPerBenchmark: number;
  benchmarks: BenchSection[];
}

export interface BenchOptions {
  runs?: number;
  benchmark?: string;
  out?: string;
  stdout?: Writable;
  repoRoot?: string;
  dataDir?: string;
  cacheRoot?: string;
  /** Provider override (test seam) — defaults to the real DeepSeek provider. */
  provider?: ChatProvider;
}

/**
 * Run every benchmark (or the one named by `benchmark`) `runs` times, then emit
 * the human table to `stdout` and the stable JSON to `out`.
 */
export async function runBench(options: BenchOptions = {}): Promise<BenchReport> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const runsPerBenchmark = options.runs ?? 3;
  if (!Number.isInteger(runsPerBenchmark) || runsPerBenchmark < 1) {
    throw new Error(`--runs must be a positive integer, got ${runsPerBenchmark}`);
  }
  const stdout = options.stdout ?? process.stdout;

  const ownedDataDir = options.dataDir === undefined;
  const ownedCacheRoot = options.cacheRoot === undefined;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "repocoach-bench-data-"));
  const cacheRoot = options.cacheRoot ?? mkdtempSync(join(tmpdir(), "repocoach-bench-cache-"));

  try {
    const benchmarks = loadBenchmarks(repoRoot, options.benchmark);
    const provider = options.provider ?? buildRealProvider(repoRoot);
    const asm = assembleSession({ repoRoot, dataDir, cacheRoot, provider });

    const sections: BenchSection[] = [];
    for (const benchmark of benchmarks) {
      const { input, sha } = splitRepositoryId(benchmark.repositoryId);
      const repo = await asm.reader.importRepository(input, sha);
      assertEntryFilesExist(asm, repo, benchmark);

      const runs: BenchRunEntry[] = [];
      for (let index = 0; index < runsPerBenchmark; index++) {
        const run = await runEvalSession({
          asm,
          repo,
          repositoryPath: benchmark.repositoryId,
          featureId: benchmark.featureId,
          featureGoal: benchmark.featureGoal,
          answers: benchmark.answers,
          entryFiles: benchmark.entryFiles,
        });
        runs.push({
          run: index + 1,
          endedPhase: run.endedPhase,
          degraded: run.degraded,
          metrics: collectBenchMetrics(run),
        });
      }
      sections.push({
        name: benchmark.name,
        repositoryId: benchmark.repositoryId,
        featureId: benchmark.featureId,
        featureGoal: benchmark.featureGoal,
        runs,
        summary: summarizeBenchSection(runs.map((entry) => entry.metrics)),
      });
    }

    const report: BenchReport = { runsPerBenchmark, benchmarks: sections };
    stdout.write(renderBenchReport(report));
    writeBenchReport(report, options.out ?? join(repoRoot, "bench-report.json"));
    return report;
  } finally {
    if (ownedDataDir) rmSync(dataDir, { recursive: true, force: true });
    if (ownedCacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  }
}

/** Reduce one `EvalRun` to the benchmark's per-run raw values. */
export function collectBenchMetrics(run: EvalRun): BenchRunMetrics {
  let peakRequestBytes = 0;
  let toolResultBytes = 0;
  let compressibleBytes = 0;
  for (const request of run.providerRequests) {
    if (request.bytes > peakRequestBytes) {
      peakRequestBytes = request.bytes;
    }
    toolResultBytes += request.toolResultBytes;
    compressibleBytes += request.compressibleBytes;
  }
  return {
    completedQuestions: run.turnCount,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    providerCalls: run.providerRequests.length,
    toolCalls: { ...run.toolCalls },
    peakRequestBytes,
    toolResultBytes,
    compressibleBytes,
  };
}

/** Median + (min–max) spread over the per-run values of every metric. */
export function summarizeBenchSection(runs: readonly BenchRunMetrics[]): BenchSectionSummary {
  const values = <K extends BenchMetricKey>(key: K): number[] => runs.map((run) => run[key]);
  return {
    metrics: {
      completedQuestions: requireSpread(values("completedQuestions")),
      inputTokens: requireSpread(values("inputTokens")),
      outputTokens: requireSpread(values("outputTokens")),
      providerCalls: requireSpread(values("providerCalls")),
      peakRequestBytes: requireSpread(values("peakRequestBytes")),
      toolResultBytes: requireSpread(values("toolResultBytes")),
      compressibleBytes: requireSpread(values("compressibleBytes")),
    },
    toolCalls: summarizeToolCalls(runs),
  };
}

function summarizeToolCalls(runs: readonly BenchRunMetrics[]): Record<string, Spread> {
  const names = new Set<string>();
  for (const run of runs) {
    for (const name of Object.keys(run.toolCalls)) {
      names.add(name);
    }
  }
  const summary: Record<string, Spread> = {};
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    summary[name] = requireSpread(runs.map((run) => run.toolCalls[name] ?? 0));
  }
  return summary;
}

/** `runBench` guarantees at least one run, so an empty spread is an internal error. */
function requireSpread(values: number[]): Spread {
  const result = spread(values);
  if (result === undefined) {
    throw new Error("internal error: cannot summarize an empty run set");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rendering + disk
// ---------------------------------------------------------------------------

const METRIC_ROWS: ReadonlyArray<{ key: BenchMetricKey; label: string }> = [
  { key: "completedQuestions", label: "completed questions" },
  { key: "inputTokens", label: "input tokens" },
  { key: "outputTokens", label: "output tokens" },
  { key: "providerCalls", label: "provider calls" },
  { key: "peakRequestBytes", label: "peak request bytes" },
  { key: "toolResultBytes", label: "tool result bytes" },
  { key: "compressibleBytes", label: "compressible bytes" },
];

/** Stable JSON (the artifact diffed across before/after runs), full raw runs kept. */
export function serializeBenchReport(report: BenchReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function writeBenchReport(report: BenchReport, path: string): void {
  writeFileSync(path, serializeBenchReport(report), "utf8");
}

/** Render the human table: one section per benchmark, median + (min–max) per metric. */
export function renderBenchReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("RepoCoach Benchmark Report");
  lines.push("=".repeat(58));
  lines.push(`${report.runsPerBenchmark} run(s) per benchmark; values are median (min–max).`);
  lines.push("");

  for (const section of report.benchmarks) {
    lines.push(
      `${renderInline(section.name)}  ${renderInline(section.repositoryId)} — ${neutralizeMarkdown(section.featureGoal)}`,
    );
    lines.push(`  feature: ${renderInline(section.featureId)}`);
    for (const run of section.runs) {
      if (run.degraded || run.endedPhase === "error") {
        const reason = run.endedPhase === "error" ? "ended in error" : "degraded";
        lines.push(`  warning: run ${run.run} ${reason} — its numbers are not comparable`);
      }
    }
    lines.push("");

    const rows: string[][] = METRIC_ROWS.map(({ key, label }) =>
      spreadRow(label, section.summary.metrics[key]),
    );
    for (const [name, spreadValue] of Object.entries(section.summary.toolCalls)) {
      rows.push(spreadRow(`tool: ${name}`, spreadValue));
    }
    lines.push(...alignRows(["metric", "median", "min", "max"], rows));
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function spreadRow(label: string, value: Spread): string[] {
  return [label, formatNumber(value.median), formatNumber(value.min), formatNumber(value.max)];
}

/** Align a header + data rows into a fixed-width table. */
function alignRows(header: string[], rows: string[][]): string[] {
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...rows.map((row) => row[column].length)),
  );
  const renderRow = (row: string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [renderRow(header), "-".repeat(58), ...rows.map(renderRow)];
}

/** Integers get thousands separators; a fractional median keeps one decimal. */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
}

/**
 * Fail before spending a single model call when a benchmark's pinned entry
 * files are not in the pinned commit. A benchmark whose entry files do not
 * resolve still *runs* — the outline is simply empty and the model explores
 * from scratch — which silently turns a pinned comparison back into the
 * unpinned one it was built to replace. That happened: the first draft of
 * `real-repos.json` pointed Zod at `src/types.ts`, a path that does not exist
 * at any commit of the current layout, and nothing complained.
 */
function assertEntryFilesExist(
  asm: SessionAssembly,
  repo: Repository,
  benchmark: Benchmark,
): void {
  const missing = benchmark.entryFiles.filter((path) => {
    try {
      asm.reader.readFile(repo, path);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `benchmark "${benchmark.name}": entry files not readable at the pinned commit: ` +
        `${missing.join(", ")}. Fix fixtures/benchmarks/real-repos.json — a benchmark ` +
        `whose entry files do not resolve measures an unpinned session.`,
    );
  }
}

function buildRealProvider(repoRoot: string): ChatProvider {
  const config = loadConfig(join(repoRoot, ".env.local"));
  return new DeepSeekProvider({ apiKey: config.deepseekKey, model: DEFAULT_DEEPSEEK_MODEL });
}

function defaultRepoRoot(): string {
  // src/eval/bench.ts and dist/eval/bench.js are both two levels below the
  // project root, so `../../` resolves to it in source and build runs alike.
  return fileURLToPath(new URL("../../", import.meta.url));
}
