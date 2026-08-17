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
import type { AgentLoopEvent } from "../agent/index.js";
import type { SessionAssembly } from "../cli/assemble.js";
import { lastFeedback, renderRecap } from "../cli/recap.js";
import type { Repository } from "../reader/index.js";
import { repeatedReadCount, type ReadOccurrence } from "./metrics.js";
import type {
  EvalEndPhase,
  EvalRun,
  EvalTurn,
  ProviderRequestRecord,
} from "./types.js";

export interface RunSessionOptions {
  asm: SessionAssembly;
  repo: Repository;
  repositoryPath: string;
  featureId: string;
  featureGoal: string;
  /** Scripted learner answers, consumed in order; running out skips the rest. */
  answers: string[];
  /** Cross-turn read-cache carry (default true); false = pre-#25 behaviour. */
  carry?: boolean;
  /** Entry files of the feature candidate (preloads the first-turn outline). */
  entryFiles?: string[];
}

export async function runEvalSession(options: RunSessionOptions): Promise<EvalRun> {
  const { asm, repo, repositoryPath, featureId, featureGoal, answers, carry, entryFiles } = options;
  const carryReadContext = carry ?? true;
  const session = asm.store.createSession({ repositoryId: repositoryPath, featureId });

  // Instrument the loop via its event stream: tool-call counts, content-returning
  // reads (for the repeated-reads metric), per-turn carried bytes, the
  // first-turn entry outline bytes, and the per-call payload figures from the
  // `provider_request` event (#36). These are counts the harness records while
  // the loop runs; they never alter behaviour.
  const toolCalls = new Map<string, number>();
  const reads: ReadOccurrence[] = [];
  const carriedBytes: number[] = [];
  const entryOutlineBytes: number[] = [];
  const providerRequests: ProviderRequestRecord[] = [];
  const onEvent = (event: AgentLoopEvent): void => {
    switch (event.type) {
      case "tool_call_started":
        toolCalls.set(event.name, (toolCalls.get(event.name) ?? 0) + 1);
        break;
      case "read_file_content":
        reads.push({
          path: event.path,
          startLine: event.startLine,
          endLine: event.endLine,
          turnIndex: event.turnIndex,
        });
        break;
      case "carried_context":
        carriedBytes.push(event.bytes);
        break;
      case "entry_outline":
        entryOutlineBytes.push(event.bytes);
        break;
      case "provider_request":
        providerRequests.push({
          round: event.round,
          messageCount: event.messageCount,
          bytes: event.bytes,
          toolResultBytes: event.toolResultBytes,
          compressibleBytes: event.compressibleBytes,
        });
        break;
      default:
        break;
    }
  };

  const { orchestrator } = asm.buildOrchestrator(
    repo,
    session.id,
    featureGoal,
    onEvent,
    { carryReadContext, entryFiles },
  );

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
  // Questions asked (prediction + follow-ups), read back from the store rather
  // than counted from `turns`: recap/degraded turns are in that array too.
  const turnCount = asm.store.getSession(session.id)?.turnCount ?? 0;
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
    toolCalls: Object.fromEntries(toolCalls),
    repeatedReads: repeatedReadCount(reads),
    carriedBytes,
    saveEvidenceCalls: toolCalls.get("repo_save_evidence") ?? 0,
    entryOutlineBytes,
    providerRequests,
    turnCount,
  };
}
