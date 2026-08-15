/**
 * Eval CLI orchestration — assembles the real graph once, imports the fixture,
 * runs the primary session plus the two adaptation sessions, scores every
 * live-session metric, then runs the isolated judge eval over the annotated
 * samples, and emits the report (human table on stdout, stable JSON on disk).
 *
 * `mock` uses the deterministic scripted provider; `real` builds the DeepSeek
 * provider from `.env.local`. Both share the same runner, metrics and judge
 * harness — only the provider differs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChatProvider } from "../agent/provider.js";
import { DEFAULT_DEEPSEEK_MODEL, DeepSeekProvider } from "../agent/index.js";
import { loadConfig } from "../config.js";
import { assembleSession } from "../cli/assemble.js";
import {
  INCORRECT_PREDICTION_ANSWER,
  loadAnswerSamples,
  loadCallChain,
} from "./fixtures.js";
import { judgeSamples } from "./judge.js";
import { createMockEvalProvider } from "./mock-provider.js";
import {
  adaptation,
  evidencePrecision,
  hallucination,
  pathAccuracy,
  sessionCost,
} from "./metrics.js";
import {
  abComparisonValidity,
  buildReport,
  renderAbComparison,
  renderReport,
  writeReport,
  type EvalMode,
  type EvalReport,
} from "./report.js";
import { runEvalSession } from "./runner.js";

export interface EvalCliOptions {
  repoRoot?: string;
  repositoryPath?: string;
  featureId?: string;
  /** JSON report path (default `<repoRoot>/eval-report.json`). */
  out?: string;
  dataDir?: string;
  cacheRoot?: string;
  stdout?: Writable;
  /** Cross-turn read-cache carry (default true); false = pre-#25 behaviour. */
  carry?: boolean;
}

export async function runEval(
  mode: EvalMode,
  options: EvalCliOptions = {},
): Promise<EvalReport> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const repositoryPath = options.repositoryPath ?? join(repoRoot, "fixtures", "fixture-repo");
  const featureId = options.featureId ?? "task-creation";
  const stdout = options.stdout ?? process.stdout;

  const ownedDataDir = options.dataDir === undefined;
  const ownedCacheRoot = options.cacheRoot === undefined;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "repocoach-eval-data-"));
  const cacheRoot = options.cacheRoot ?? mkdtempSync(join(tmpdir(), "repocoach-eval-cache-"));

  try {
    const samples = loadAnswerSamples(repoRoot);
    const callChain = loadCallChain(repoRoot);
    const provider =
      mode === "mock" ? createMockEvalProvider(samples) : buildRealProvider(repoRoot);
    const asm = assembleSession({ repoRoot, dataDir, cacheRoot, provider });
    const repo = await asm.reader.importRepository(repositoryPath);

    const candidates = await asm.candidateProvider.listCandidates(repo);
    const candidate = candidates.find((item) => item.id === featureId);
    if (candidate === undefined) {
      throw new Error(`No feature candidate "${featureId}" in ${repositoryPath}`);
    }
    const featureGoal = `${candidate.title} — ${candidate.description}`;

    // The fixture's canonical prediction answer (correct) and follow-up answer
    // ("who assigns the id", incorrect) — see answer-samples.json indexes 0/7.
    const prediction = samples[0];
    const followUp = samples[7];
    if (prediction === undefined || followUp === undefined) {
      throw new Error("answer-samples.json is missing its prediction/follow-up samples");
    }

    const run = await runEvalSession({
      asm,
      repo,
      repositoryPath,
      featureId,
      featureGoal,
      answers: [prediction.userAnswer, followUp.userAnswer],
      carry: options.carry,
    });
    const correctRun = await runEvalSession({
      asm,
      repo,
      repositoryPath,
      featureId,
      featureGoal,
      answers: [prediction.userAnswer],
      carry: options.carry,
    });
    const incorrectRun = await runEvalSession({
      asm,
      repo,
      repositoryPath,
      featureId,
      featureGoal,
      answers: [INCORRECT_PREDICTION_ANSWER],
      carry: options.carry,
    });

    const knownSymbols = callChain.map((step) => step.symbol);
    const report = buildReport({
      mode,
      run,
      metrics: {
        evidencePrecision: evidencePrecision(run, asm.reader, repo, knownSymbols),
        pathAccuracy: pathAccuracy(run, callChain),
        adaptation: adaptation(
          correctRun,
          incorrectRun,
          prediction.userAnswer,
          INCORRECT_PREDICTION_ANSWER,
        ),
        hallucination: await hallucination(
          `${run.recap}\n${run.finalFeedback}`,
          asm.reader,
          repo,
          knownSymbols,
        ),
        cost: sessionCost(run),
      },
      judge: await judgeSamples({
        provider,
        reader: asm.reader,
        repo,
        featureGoal,
        samples,
      }),
    });

    stdout.write(renderReport(report));
    writeReport(report, options.out ?? join(repoRoot, "eval-report.json"));
    return report;
  } finally {
    if (ownedDataDir) rmSync(dataDir, { recursive: true, force: true });
    if (ownedCacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function buildRealProvider(repoRoot: string): ChatProvider {
  const config = loadConfig(join(repoRoot, ".env.local"));
  return new DeepSeekProvider({ apiKey: config.deepseekKey, model: DEFAULT_DEEPSEEK_MODEL });
}

/**
 * A/B comparison for issue #25: run the "carry off" arm (pre-optimisation
 * behaviour) then the "carry on" arm, sequentially in one process so the two
 * arms never race the provider. Each arm's JSON report is written separately;
 * only the side-by-side comparison table goes to stdout.
 */
export async function runAbEval(options: EvalCliOptions = {}): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const base = options.out ?? join(defaultRepoRoot(), "eval-report.json");
  const off = await runEval("real", {
    ...options,
    carry: false,
    out: abOutPath(base, "off"),
    stdout: discardStream(),
  });
  const on = await runEval("real", {
    ...options,
    carry: true,
    out: abOutPath(base, "on"),
    stdout: discardStream(),
  });
  // A degraded or errored arm has near-zero repeated reads and lower call counts
  // for reasons unrelated to the optimisation, so presenting it as the "better"
  // arm would be a lie. Fail loudly instead of printing a comparison table.
  const validity = abComparisonValidity(off, on);
  if (!validity.valid) {
    throw new Error(`A/B comparison not evaluable: ${validity.reason}`);
  }
  stdout.write(renderAbComparison(off, on));
}

/** `eval-report.json` → `eval-report.<arm>.json`. */
function abOutPath(base: string, arm: "off" | "on"): string {
  return base.replace(/\.json$/, `.${arm}.json`);
}

/** A Writable that discards everything — suppresses the per-arm human reports. */
function discardStream(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

function defaultRepoRoot(): string {
  // src/eval/cli.ts and dist/eval/cli.js are both two levels below the project
  // root, so `../../` resolves to it in source and build runs alike.
  return fileURLToPath(new URL("../../", import.meta.url));
}
