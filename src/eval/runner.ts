/**
 * Eval runner — drives one full learning session through the REAL assembly
 * (`assembleSession` + `buildOrchestrator`), feeding a scripted answer queue,
 * and records a structured `EvalRun`.
 *
 * There is deliberately no parallel "eval assembly": reusing the production
 * path (with its mandatory grounding) is the whole point — a harness that
 * skipped grounding would not measure the real behaviour. See
 * docs/architecture.md §7.
 */

import { performance } from "node:perf_hooks";
import type { SessionAssembly } from "../cli/assemble.js";
import { lastFeedback, renderRecap } from "../cli/recap.js";
import type { Repository } from "../reader/index.js";
import type { EvalEndPhase, EvalRun, EvalTurn } from "./types.js";

export interface RunSessionOptions {
  asm: SessionAssembly;
  repo: Repository;
  repositoryPath: string;
  featureId: string;
  featureGoal: string;
  /** Scripted learner answers, consumed in order; running out skips the rest. */
  answers: string[];
}

export async function runEvalSession(options: RunSessionOptions): Promise<EvalRun> {
  const { asm, repo, repositoryPath, featureId, featureGoal, answers } = options;
  const session = asm.store.createSession({ repositoryId: repositoryPath, featureId });
  const { orchestrator } = asm.buildOrchestrator(repo, session.id, featureGoal);

  const turns: EvalTurn[] = [];
  const startedAt = performance.now();
  let answer: string | undefined;
  let skip = false;
  let answerIndex = 0;
  let endedPhase: EvalEndPhase;
  let degraded: boolean;

  for (;;) {
    const result = skip ? await orchestrator.skip() : await orchestrator.step(answer);
    turns.push({
      phase: result.phase,
      question: result.decision?.question ?? "",
      userAnswer: result.turn?.userAnswer,
      assessment: result.decision?.assessment,
      feedback: result.decision?.feedback,
      evidence: result.decision?.evidence ?? [],
      skipped: result.turn?.skipped,
      decisionOverridden: result.turn?.decisionOverridden,
    });
    answer = undefined;
    skip = false;

    if (result.phase === "recap" || result.phase === "error") {
      endedPhase = result.phase;
      degraded = result.phase === "recap" && result.decision === null;
      break;
    }

    const question = result.decision?.question;
    const waitingForAnswer = result.phase === "hypothesis" || result.phase === "questioning";
    if (waitingForAnswer && question !== undefined && question.trim() !== "") {
      const next = answers[answerIndex];
      if (next === undefined) {
        skip = true;
      } else {
        answer = next;
        answerIndex += 1;
      }
    }
  }

  const wallClockMs = Math.round(performance.now() - startedAt);
  const persistedTurns = asm.store.listTurns(session.id);
  const finalFeedback = lastFeedback(persistedTurns);
  const recap = renderRecap({
    sessionId: session.id,
    evidenceStore: asm.evidenceStore,
    reader: asm.reader,
    repo,
    turns: persistedTurns,
    finalFeedback,
    durationMs: asm.store.sessionDuration(session.id),
  });

  return {
    repositoryPath,
    featureId,
    featureGoal,
    turns,
    finalFeedback,
    recap,
    usage: orchestrator.accumulatedUsage,
    wallClockMs,
    degraded,
    endedPhase,
  };
}
