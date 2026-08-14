/**
 * Deterministic scripted provider for `pnpm eval:mock`.
 *
 * It plays the part of a "perfect" model: it asks the fixture's prediction
 * question, reads the real call chain through the ordinary tool loop (so the
 * constructive grounding still runs), assesses the learner answer from the
 * annotated samples, and adapts its follow-up question to that assessment. The
 * mock therefore goes through the REAL AgentLoop + grounding path while
 * producing a byte-for-byte predictable session the metrics can be verified
 * against. See docs/architecture.md §7.
 */

import type { Assessment, Evidence, TokenUsage } from "../domain/index.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatProvider,
} from "../agent/provider.js";
import type { AnswerSample } from "./fixtures.js";

/**
 * The five evidence records the mock cites, matching
 * `fixtures/expectations/call-chain.json` exactly (path + line range). Reasons
 * name the symbol the range demonstrates, so evidence-precision can verify each.
 */
const EVIDENCE: Evidence[] = [
  { path: "src/index.ts", startLine: 25, endLine: 43, reason: "createTracker wires parse → validate → store → render" },
  { path: "src/parse/task.ts", startLine: 22, endLine: 49, reason: "parseTask splits the raw string into fields" },
  { path: "src/parse/validate.ts", startLine: 24, endLine: 32, reason: "validate rejects empty titles and assignees" },
  { path: "src/store/memory.ts", startLine: 17, endLine: 22, reason: "MemoryStore.add assigns an id and stores the task" },
  { path: "src/render/format.ts", startLine: 12, endLine: 15, reason: "formatTask renders the stored task back to a string" },
];

const FINAL_FEEDBACK = [
  "Follow-up questions:",
  "- How does validate behave when a task has no assignee?",
  "Next steps:",
  "- Read src/util/format.ts and contrast it with src/render/format.ts.",
].join("\n");

const FOLLOWUP_FEEDBACK =
  "Ids are assigned by MemoryStore.add; parseTask only splits the raw string.";

export interface MockEvalConfig {
  predictionQuestion: string;
  /** Follow-up asked after a correct prediction. */
  followUpWhenCorrect: string;
  /** Follow-up asked after an incorrect/unknown prediction (must differ). */
  followUpWhenNotCorrect: string;
  finalFeedback: string;
  assess: (answer: string | undefined) => Assessment;
}

export class MockEvalProvider implements ChatProvider {
  constructor(private readonly config: MockEvalConfig) {}

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const phase = extractPhase(request.messages);
    const answer = extractAnswer(request.messages);
    const message = this.respond(phase, answer, request.messages);
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 1 };
    return { message, usage };
  }

  private respond(
    phase: string,
    answer: string | undefined,
    messages: ChatMessage[],
  ): ChatMessage {
    switch (phase) {
      case "orientation":
        return decision({ evidence: [], nextAction: "show_evidence" });
      case "hypothesis":
        return decision({
          question: this.config.predictionQuestion,
          evidence: [],
          nextAction: "ask",
        });
      case "trace": {
        // First pass: read the whole chain. Second pass (once the tool results
        // are in the messages) submits grounded evidence + the assessment.
        if (!messages.some((message) => message.role === "tool")) {
          return this.reads();
        }
        // The learner answer was consumed in the hypothesis → trace transition,
        // so it arrives via the turn-history summary, not the current
        // instruction ("Proceed with the current phase.").
        const assessment = this.config.assess(lastUserAnswer(messages));
        return decision({
          evidence: EVIDENCE,
          assessment,
          feedback: traceFeedback(assessment),
          nextAction: "show_evidence",
        });
      }
      case "questioning": {
        if (answer !== undefined) {
          return decision({
            evidence: [],
            assessment: this.config.assess(answer),
            feedback: FOLLOWUP_FEEDBACK,
            nextAction: "finish",
          });
        }
        const prior = lastAssessment(messages);
        const question =
          prior === "correct"
            ? this.config.followUpWhenCorrect
            : this.config.followUpWhenNotCorrect;
        return decision({ question, evidence: [], nextAction: "ask" });
      }
      case "feedback":
        return decision({
          evidence: [],
          nextAction: "finish",
          feedback: this.config.finalFeedback,
        });
      default:
        // recap / error are terminal; the loop never calls the provider there.
        return decision({ evidence: [], nextAction: "finish" });
    }
  }

  private reads(): ChatMessage {
    return {
      role: "assistant",
      content: null,
      toolCalls: EVIDENCE.map((evidence, index) => ({
        id: `read-${index + 1}`,
        name: "repo_read_file",
        arguments: JSON.stringify({
          path: evidence.path,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
        }),
      })),
    };
  }
}

function traceFeedback(assessment: Assessment): string {
  return assessment === "correct"
    ? "Correct — the full chain is parse → validate → store → render."
    : "That does not match the real parse → validate → store → render chain.";
}

/** Build the default mock config, with assessments taken from the samples. */
export function createMockEvalProvider(samples: AnswerSample[]): MockEvalProvider {
  const byAnswer = new Map(
    samples.map((sample) => [sample.userAnswer, sample.expectedAssessment]),
  );
  const config: MockEvalConfig = {
    predictionQuestion: sampleQuestion(samples, 0, "prediction"),
    followUpWhenCorrect: sampleQuestion(samples, 7, "follow-up"),
    followUpWhenNotCorrect:
      "Where does the raw string get split into fields, and which module stores the result?",
    finalFeedback: FINAL_FEEDBACK,
    assess(answer) {
      return answer === undefined ? "unknown" : (byAnswer.get(answer) ?? "unknown");
    },
  };
  return new MockEvalProvider(config);
}

function sampleQuestion(
  samples: AnswerSample[],
  index: number,
  label: string,
): string {
  const sample = samples[index];
  if (sample === undefined) {
    throw new Error(`answer-samples.json is missing its ${label} sample (index ${index})`);
  }
  return sample.question;
}

/** Wrap an assistant tool call to `submit_decision`. */
function decision(args: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    content: null,
    toolCalls: [
      { id: "decision", name: "submit_decision", arguments: JSON.stringify(args) },
    ],
  };
}

/** The current phase from the fixed system prompt (`Current phase: <phase>`). */
function extractPhase(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role === "system" && message.content !== null) {
      const match = message.content.match(/Current phase:\s*([A-Za-z]+)/);
      if (match) return match[1]!;
    }
  }
  return "unknown";
}

/** The learner answer fed into the current turn, if any. */
function extractAnswer(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    if (
      message.role === "user" &&
      message.content !== null &&
      message.content.startsWith("The learner answered: ")
    ) {
      return message.content.slice("The learner answered: ".length);
    }
  }
  return undefined;
}

/** The most recent assessment recorded in the turn-history summary. */
function lastAssessment(messages: ChatMessage[]): Assessment | undefined {
  let found: Assessment | undefined;
  for (const message of messages) {
    if (message.content === null) continue;
    for (const match of message.content.matchAll(
      /assessment:\s*(correct|partial|incorrect|unknown)/g,
    )) {
      found = match[1] as Assessment;
    }
  }
  return found;
}

/** The most recent learner answer in the turn-history summary (`A: <answer>`). */
function lastUserAnswer(messages: ChatMessage[]): string | undefined {
  let found: string | undefined;
  for (const message of messages) {
    if (message.content === null) continue;
    for (const match of message.content.matchAll(/\bA: ([^|\n]+)/g)) {
      found = match[1]?.trim();
    }
  }
  return found;
}
