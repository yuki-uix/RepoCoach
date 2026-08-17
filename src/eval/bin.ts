#!/usr/bin/env node
import { renderInline } from "../cli/markdown.js";
import { runBench } from "./bench.js";
import { runAbEval, runEval } from "./cli.js";
import type { EvalMode } from "./report.js";

const modeArg = process.argv[2];
const mode: EvalMode = modeArg === "real" ? "real" : "mock";
const isAb = modeArg === "ab";
const isBench = modeArg === "bench";
const out = optionValue("--out");
const carry = !hasFlag("--no-carry");
const runsArg = optionValue("--runs");
const runs = runsArg === undefined ? undefined : Number(runsArg);
const benchmark = optionValue("--benchmark");

try {
  if (isBench) {
    await runBench({ runs, benchmark, out });
  } else if (isAb) {
    await runAbEval({ out });
  } else {
    await runEval(mode, { out, carry });
  }
  process.exitCode = 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${renderInline(message)}\n`);
  process.exitCode = 1;
}

function optionValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
