/**
 * Test helpers for the CLI module: a scripted ChatProvider replaying
 * assistant tool-call messages, plus stream capture built on node Writable /
 * PassThrough so no test touches a real TTY or the network.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatProvider,
} from "../../src/agent";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");

export interface ScriptedToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** An assistant message carrying a single tool call. */
export function toolMessage(id: string, name: string, args: unknown): ChatMessage {
  return toolCallsMessage([{ id, name, args }]);
}

/** An assistant message carrying several tool calls in one turn. */
export function toolCallsMessage(calls: ScriptedToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: null,
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.args),
    })),
  };
}

/** Replay `responses` verbatim, one per provider call, logging the requests. */
export function scriptedProvider(
  responses: ChatMessage[],
  requests?: ChatCompletionRequest[],
): ChatProvider {
  let callIndex = 0;
  return {
    async complete(request) {
      requests?.push(request);
      const message = responses[callIndex];
      callIndex += 1;
      return { message, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

export function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), "repocoach-cli-"));
}

export interface CapturedStreams {
  stdin: PassThrough;
  stdout: Writable;
  stderr: Writable;
  stdoutText(): string;
  stderrText(): string;
}

/** A PassThrough stdin plus Writable stdout/stderr that accumulate synchronously. */
export function capturedStreams(): CapturedStreams {
  const stdin = new PassThrough();
  const stdout = captureWritable();
  const stderr = captureWritable();
  return {
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdoutText: stdout.text,
    stderrText: stderr.text,
  };
}

function captureWritable(): { stream: Writable; text(): string } {
  let buffer = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}

export const PREDICTION_Q =
  "When a task is added via createTracker(), which modules does the data flow through, in order?";
export const FOLLOWUP_Q = "Who assigns a task its id?";
export const FINAL_FEEDBACK = [
  "Follow-up questions:",
  "- How does validate behave when a task has no assignee?",
  "Next steps:",
  "- Read src/util/format.ts and contrast it with src/render/format.ts.",
].join("\n");

export const EVIDENCE = [
  {
    path: "src/index.ts",
    startLine: 25,
    endLine: 43,
    reason: "createTracker wires parse → validate → store → render",
  },
  {
    path: "src/parse/task.ts",
    startLine: 22,
    endLine: 49,
    reason: "parseTask splits the raw string into fields",
  },
  {
    path: "src/parse/validate.ts",
    startLine: 24,
    endLine: 32,
    reason: "validate rejects empty titles and assignees",
  },
  {
    path: "src/store/memory.ts",
    startLine: 17,
    endLine: 22,
    reason: "MemoryStore.add assigns an id and stores the task",
  },
  {
    path: "src/render/format.ts",
    startLine: 12,
    endLine: 15,
    reason: "formatTask renders the stored task back to a string",
  },
];

/**
 * The full five-phase decision sequence the Orchestrator drives, as a flat
 * list of assistant tool-call messages. Each `orchestrator.step()` maps to one
 * or more provider calls: the trace step reads the whole call chain first,
 * then submits grounded evidence.
 */
export function fullSessionScript(): ChatMessage[] {
  return [
    // orientation → hypothesis
    toolMessage("c1", "submit_decision", { evidence: [], nextAction: "show_evidence" }),
    // hypothesis: ask the prediction question
    toolMessage("c2", "submit_decision", { question: PREDICTION_Q, evidence: [], nextAction: "ask" }),
    // hypothesis (answer): the decision is ignored for the transition
    toolMessage("c3", "submit_decision", { question: PREDICTION_Q, evidence: [], nextAction: "ask" }),
    // trace: read every step of the chain, then cite it as evidence
    toolCallsMessage(EVIDENCE.map((evidence, index) => ({
      id: `r${index + 1}`,
      name: "repo_read_file",
      args: { path: evidence.path, startLine: evidence.startLine, endLine: evidence.endLine },
    }))),
    toolMessage("c5", "submit_decision", {
      evidence: EVIDENCE,
      assessment: "correct",
      feedback: "Correct — you named the full parse → validate → store → render chain.",
      nextAction: "show_evidence",
    }),
    // questioning: ask a follow-up
    toolMessage("c6", "submit_decision", { question: FOLLOWUP_Q, evidence: [], nextAction: "ask" }),
    // questioning (answer) → feedback
    toolMessage("c7", "submit_decision", {
      evidence: [],
      assessment: "incorrect",
      feedback: "Ids are assigned by MemoryStore.add; parseTask only splits the string.",
      nextAction: "finish",
    }),
    // feedback → recap
    toolMessage("c8", "submit_decision", {
      evidence: [],
      nextAction: "finish",
      feedback: FINAL_FEEDBACK,
    }),
  ];
}
