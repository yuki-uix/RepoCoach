#!/usr/bin/env node
import { renderInline } from "../cli/markdown.js";
import { runEval } from "./cli.js";
import type { EvalMode } from "./report.js";

const mode: EvalMode = process.argv[2] === "real" ? "real" : "mock";
const out = optionValue("--out");

try {
  await runEval(mode, { out });
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
