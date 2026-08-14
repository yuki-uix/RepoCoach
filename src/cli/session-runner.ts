/**
 * Interactive Q&A loop.
 *
 * Drives the Orchestrator one step at a time, streaming the AgentLoop's tool
 * calls / tool results / thinking to stderr so a 20–60s turn stays visibly
 * alive, and rendering the model's evidence + question to stdout. The user
 * answer is read via the injected `prompt` (node:readline/promises in
 * production). An empty line is a skip; `/quit` abandons the session. Ctrl-C
 * exits 130 after reminding the user how to resume.
 */

import type { Writable } from "node:stream";
import type { AgentDecision, Evidence } from "../domain/index.js";
import type { AgentLoopEvent } from "../agent/index.js";
import { Orchestrator, type StepResult } from "../orchestrator/orchestrator.js";
import type { SessionStore } from "../store/index.js";
import { bold, dim, neutralizeMarkdown, renderInline } from "./markdown.js";

/** Reads one line of user input (the readline `question` seam). */
export type PromptFn = (query: string) => Promise<string>;

/** Mutable slot the loop's onEvent forwards into; swapped per step. */
export interface EventTarget {
  sink: EventSink | null;
}

export type RunOutcomePhase = "recap" | "error" | "abandoned";

export interface RunOutcome {
  phase: RunOutcomePhase;
  /** True when the recap was salvaged after the agent failed to decide. */
  degraded?: boolean;
}

/** How much text to accumulate before emitting one "thinking" progress dot. */
const TEXT_DOT_THRESHOLD = 40;
/** Max rendered width of a tool result summary line. */
const RESULT_LINE_WIDTH = 80;
/** Max rendered width of a single tool argument value. */
const ARG_VALUE_WIDTH = 60;

/** Renders one turn's agent events to stderr, aggregating text into dots. */
class EventSink {
  private thinking = false;
  private sinceDot = 0;

  constructor(private readonly stderr: Writable) {}

  push(event: AgentLoopEvent): void {
    switch (event.type) {
      case "tool_call_started":
        this.stderr.write(
          dim(`→ ${renderInline(event.name)}${formatToolArgs(event.name, event.arguments)}`) + "\n",
        );
        break;
      case "tool_result":
        this.stderr.write(dim(`  ${summarize(event.result)}`) + "\n");
        break;
      case "text_delta":
        this.progress(event.delta);
        break;
      case "decision_submitted":
        break;
    }
  }

  flush(): void {
    if (this.thinking) {
      this.stderr.write("\n");
      this.thinking = false;
      this.sinceDot = 0;
    }
  }

  private progress(delta: string): void {
    if (!this.thinking) {
      this.stderr.write("thinking");
      this.thinking = true;
    }
    this.sinceDot += delta.length;
    while (this.sinceDot >= TEXT_DOT_THRESHOLD) {
      this.stderr.write(".");
      this.sinceDot -= TEXT_DOT_THRESHOLD;
    }
  }
}

export { EventSink };

export interface SessionRunnerDeps {
  orchestrator: Orchestrator;
  store: SessionStore;
  sessionId: string;
  stdout: Writable;
  stderr: Writable;
  prompt: PromptFn;
  /** Shared sink slot, wired to the loop's onEvent at assembly time. */
  target: EventTarget;
}

export class SessionRunner {
  private readonly deps: SessionRunnerDeps;

  constructor(deps: SessionRunnerDeps) {
    this.deps = deps;
  }

  /** Advance one step, streaming tool/thinking events to stderr. */
  async advance(input: { answer?: string; skip?: boolean } = {}): Promise<StepResult> {
    const sink = new EventSink(this.deps.stderr);
    this.deps.target.sink = sink;
    try {
      return input.skip
        ? await this.deps.orchestrator.skip()
        : await this.deps.orchestrator.step(input.answer);
    } finally {
      sink.flush();
      this.deps.target.sink = null;
    }
  }

  /** Run the loop until a terminal phase (or an explicit quit). */
  async run(): Promise<RunOutcome> {
    let answer: string | undefined;
    let skip = false;

    const onSigint = (): void => {
      this.deps.stderr.write(
        `\nSession saved. 可用 repocoach resume ${renderInline(this.deps.sessionId)} 恢复\n`,
      );
      process.exit(130);
    };
    process.on("SIGINT", onSigint);
    try {
      for (;;) {
        const result = await this.advance({ answer, skip });
        answer = undefined;
        skip = false;

        const terminal = result.phase === "recap" || result.phase === "error";
        const decisionText = renderDecision(result.decision, terminal);
        if (decisionText !== "") {
          this.deps.stdout.write(decisionText);
        }

        if (result.phase === "recap") {
          return { phase: "recap", degraded: result.decision === null };
        }
        if (result.phase === "error") {
          return { phase: "error" };
        }

        const question = result.decision?.question;
        const waitingForAnswer =
          result.phase === "hypothesis" || result.phase === "questioning";
        if (
          waitingForAnswer &&
          question !== undefined &&
          question.trim() !== ""
        ) {
          this.deps.stdout.write(renderQuestion(question));
          const line = await this.deps.prompt("> ");
          const trimmed = line.trim();
          if (trimmed === "/quit") {
            this.deps.store.updateSession(this.deps.sessionId, { status: "abandoned" });
            return { phase: "abandoned" };
          }
          if (trimmed === "") {
            skip = true;
          } else {
            answer = trimmed;
          }
        }
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }

}

/** Width of the separator rule drawn above a question. */
const QUESTION_RULE_WIDTH = 60;

/**
 * Render a turn's evidence (and mid-session feedback) for stdout. The final
 * feedback-phase decision is skipped here — its follow-up questions and next
 * steps belong to the recap, not the live loop.
 */
export function renderDecision(decision: AgentDecision | null, terminal: boolean): string {
  if (decision === null) {
    return "";
  }
  let out = "";
  if (decision.evidence.length > 0) {
    out += renderEvidenceBlock(decision.evidence);
  }
  if (!terminal && decision.feedback !== undefined && decision.feedback !== "") {
    out += `${neutralizeMarkdown(decision.feedback)}\n`;
  }
  return out;
}

/**
 * Render evidence as an indented, dimmed group so it reads apart from the
 * question text. The question is rendered separately (after evidence) at the
 * end of the turn, adjacent to the input prompt.
 */
export function renderEvidenceBlock(evidence: Evidence[]): string {
  return evidence
    .map((item, index) => {
      const branch = index === evidence.length - 1 ? "└─" : "├─";
      return dim(`  ${branch} ${formatEvidence(item)}`);
    })
    .join("\n") + "\n";
}

/** Render a highlighted question with a separator rule above it. */
export function renderQuestion(question: string): string {
  return `${dim("─".repeat(QUESTION_RULE_WIDTH))}\n${bold(neutralizeMarkdown(question))}\n`;
}

export function formatEvidence(evidence: Evidence): string {
  return `${renderInline(evidence.path)}:${renderInline(evidence.startLine)}-${renderInline(evidence.endLine)} — ${neutralizeMarkdown(evidence.reason)}`;
}

/** `repo_search(pattern=...)` — primitive args rendered as `key=value`. */
function formatToolArgs(name: string, argumentsJson: string): string {
  if (name === "submit_decision") {
    return "";
  }
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return "";
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "";
  }
  const parts = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return `${renderInline(key)}=${truncate(renderInline(rendered), ARG_VALUE_WIDTH)}`;
  });
  return parts.length === 0 ? "" : `(${parts.join(", ")})`;
}

function summarize(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), RESULT_LINE_WIDTH);
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
