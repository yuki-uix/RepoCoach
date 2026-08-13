/**
 * Agent Loop — the self-implemented tool loop behind the Orchestrator's
 * AgentInvoker seam.
 *
 * Assembles a fixed system prompt + turn-history summary + the current user
 * input, then repeatedly calls the provider, executes tool calls (wrapping
 * every repo result in REPO_DATA markers), and stops when the model submits a
 * schema-valid decision via submit_decision. See docs/architecture.md §3, §5.
 */

import {
  agentDecisionSchema,
  type AgentDecision,
  type Evidence,
  type LearningTurn,
  type TokenUsage,
} from "../domain/index.js";
import type {
  AgentInvocation,
  AgentInvokerInput,
} from "../orchestrator/orchestrator.js";
import type { Repository, Reader } from "../reader/index.js";
import type { ToolReturnLedger } from "../evidence/ledger.js";
import {
  wrapRepoData,
  wrapUntrustedContext,
  type RepoDataMeta,
} from "./data-guard.js";
import { DEFAULT_DEEPSEEK_MODEL } from "./deepseek-provider.js";
import { describeError, formatZodError } from "./errors.js";
import type { AgentLogger } from "./logger.js";
import { noopLogger } from "./logger.js";
import type {
  ChatMessage,
  ChatProvider,
  ChatProviderEvent,
  ToolDefinition,
} from "./provider.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createToolRegistry,
  type EvidenceValidator,
  type ToolRegistry,
} from "./tools.js";

export const DEFAULT_MAX_TOOL_ROUNDS = 15;
export const MAX_DECISION_RETRIES = 2;

/** Thrown when the model never produces a schema-valid decision. */
export class AgentDecisionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDecisionInvalidError";
  }
}

export type AgentLoopEvent =
  | { type: "tool_call_started"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "text_delta"; delta: string }
  | { type: "decision_submitted"; decision: AgentDecision };

export interface AgentLoopOptions {
  provider: ChatProvider;
  reader: Reader;
  repo: Repository;
  model?: string;
  maxToolRounds?: number;
  maxDecisionRetries?: number;
  evidenceValidator?: EvidenceValidator;
  /** Per-turn record of tool returns; reset at the start of every turn. */
  ledger?: ToolReturnLedger;
  logger?: AgentLogger;
  onEvent?: (event: AgentLoopEvent) => void;
}

const FORCE_DECISION_MESSAGE =
  "You have reached the tool-call limit. Stop exploring the repository and call " +
  "submit_decision now with your best structured decision.";

const PLAIN_TEXT_NUDGE =
  "Respond by calling a tool. To finish the turn, call submit_decision with your " +
  "structured decision — never reply with plain text.";

/** submit_decision is the loop's terminal tool; its arguments ARE the decision. */
const submitDecisionTool: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_decision",
    description:
      "Submit your structured decision to end the turn. This is the only way to finish.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to pose (required when nextAction is 'ask').",
        },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 },
              reason: { type: "string" },
            },
            required: ["path", "startLine", "endLine", "reason"],
            additionalProperties: false,
          },
        },
        assessment: {
          type: "string",
          enum: ["correct", "partial", "incorrect", "unknown"],
        },
        feedback: { type: "string" },
        nextAction: { type: "string", enum: ["ask", "show_evidence", "finish"] },
      },
      required: ["evidence", "nextAction"],
      additionalProperties: false,
    },
  },
};

type DecisionOutcome =
  | { kind: "ok"; decision: AgentDecision }
  | { kind: "error"; message: string };

export class AgentLoop {
  private readonly provider: ChatProvider;
  private readonly tools: ToolRegistry;
  private readonly model: string;
  private readonly maxToolRounds: number;
  private readonly maxDecisionRetries: number;
  private readonly evidenceValidator?: EvidenceValidator;
  private readonly ledger?: ToolReturnLedger;
  private readonly logger: AgentLogger;
  private readonly onEvent?: (event: AgentLoopEvent) => void;
  private readonly allTools: ToolDefinition[];

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.evidenceValidator = options.evidenceValidator;
    this.ledger = options.ledger;
    this.tools = createToolRegistry({
      reader: options.reader,
      repo: options.repo,
      evidenceValidator: options.evidenceValidator,
      returnRecorder: options.ledger,
    });
    this.model = options.model ?? DEFAULT_DEEPSEEK_MODEL;
    this.maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.maxDecisionRetries = options.maxDecisionRetries ?? MAX_DECISION_RETRIES;
    this.logger = options.logger ?? noopLogger;
    this.onEvent = options.onEvent;
    this.allTools = [...this.tools.definitions, submitDecisionTool];
  }

  /** Run one agent turn, matching the Orchestrator's AgentInvoker contract. */
  async invoke(input: AgentInvokerInput): Promise<AgentInvocation> {
    // A new turn starts: clear last turn's tool returns and advance the
    // validator's turn association (turnIndex = number of completed turns).
    this.ledger?.resetTurn();
    this.evidenceValidator?.setTurnIndex?.(input.turnHistory.length);
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const collectedEvidence: Evidence[] = [];
    const messages = this.buildInitialMessages(input);

    let decisionRetries = 0;
    let forceMessageAdded = false;
    const maxRounds = this.maxToolRounds + this.maxDecisionRetries + 2;

    for (let round = 0; round < maxRounds; round++) {
      const forceDecision = round >= this.maxToolRounds;
      const tools = forceDecision ? [submitDecisionTool] : this.allTools;

      if (forceDecision && !forceMessageAdded) {
        messages.push({ role: "user", content: FORCE_DECISION_MESSAGE });
        forceMessageAdded = true;
      }

      const result = await this.callProvider(messages, tools);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      messages.push(result.message);

      const toolCalls = result.message.toolCalls ?? [];
      if (toolCalls.length === 0) {
        if (forceDecision) {
          throw new AgentDecisionInvalidError(
            "Model produced plain text instead of submit_decision at the tool-call limit",
          );
        }
        messages.push({ role: "user", content: PLAIN_TEXT_NUDGE });
        continue;
      }

      for (const toolCall of toolCalls) {
        this.emit({ type: "tool_call_started", name: toolCall.name, arguments: toolCall.arguments });

        if (toolCall.name === "submit_decision") {
          const outcome = this.parseDecision(toolCall.arguments);
          if (outcome.kind === "ok") {
            this.emit({ type: "decision_submitted", decision: outcome.decision });
            this.logger.info("agent decision submitted", {
              nextAction: outcome.decision.nextAction,
            });
            return { decision: outcome.decision, usage };
          }

          decisionRetries += 1;
          if (decisionRetries > this.maxDecisionRetries) {
            throw new AgentDecisionInvalidError(
              `Decision failed schema validation after ${this.maxDecisionRetries} retries: ${outcome.message}`,
            );
          }
          this.emit({ type: "tool_result", name: "submit_decision", result: outcome.message });
          this.logger.warn("agent decision rejected by schema", {
            message: outcome.message,
          });
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: outcome.message,
          });
          continue;
        }

        if (forceDecision) {
          // Only submit_decision is available when forced; treat a stray call
          // as an error result rather than executing it.
          const stray = "Error: only submit_decision is available at the tool-call limit";
          this.emit({ type: "tool_result", name: toolCall.name, result: stray });
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: wrapRepoData(stray, { tool: toolCall.name }),
          });
          continue;
        }

        const args = parseArguments(toolCall.arguments);
        const result =
          args === undefined
            ? "Error: tool arguments are not valid JSON"
            : await this.tools.execute({ name: toolCall.name, args, collectedEvidence });
        this.emit({ type: "tool_result", name: toolCall.name, result });
        this.logger.debug("agent tool result", { tool: toolCall.name });
        const meta: RepoDataMeta = {
          tool: toolCall.name,
          path: pathOfTool(toolCall.name, args),
        };
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: wrapRepoData(result, meta),
        });
      }
    }

    throw new AgentDecisionInvalidError(
      `Agent loop exceeded ${maxRounds} rounds without a valid decision`,
    );
  }

  private buildInitialMessages(input: AgentInvokerInput): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(input.phase, input.featureGoal) },
    ];
    const history = summarizeTurnHistory(input.turnHistory);
    if (history !== null) {
      // Turn-history fields are model-generated from repo content, so they are
      // as untrusted as a file read. Wrap the whole summary rather than letting
      // copied-through instructions re-enter context as unmarked directives.
      messages.push({
        role: "user",
        content: wrapUntrustedContext(history, { kind: "turn_history" }),
      });
    }
    messages.push({ role: "user", content: buildTurnInstruction(input) });
    return messages;
  }

  private async callProvider(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<{ message: ChatMessage; usage: TokenUsage }> {
    const onProviderEvent = (event: ChatProviderEvent): void => {
      this.emit({ type: "text_delta", delta: event.delta });
    };
    return this.provider.complete(
      { model: this.model, messages, tools },
      onProviderEvent,
    );
  }

  private parseDecision(argumentsJson: string): DecisionOutcome {
    let raw: unknown;
    try {
      raw = JSON.parse(argumentsJson);
    } catch (error) {
      return {
        kind: "error",
        message: `submit_decision arguments are not valid JSON: ${describeError(error)}`,
      };
    }
    const parsed = agentDecisionSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        kind: "error",
        message: `Decision rejected by schema: ${formatZodError(parsed.error)}`,
      };
    }
    return { kind: "ok", decision: parsed.data };
  }

  private emit(event: AgentLoopEvent): void {
    this.onEvent?.(event);
  }
}

function parseArguments(argumentsJson: string): unknown | undefined {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
}

function pathOfTool(name: string, args: unknown): string | undefined {
  if (name !== "repo_read_file" && name !== "repo_save_evidence") {
    return undefined;
  }
  if (typeof args === "object" && args !== null) {
    const path = (args as Record<string, unknown>).path;
    if (typeof path === "string") {
      return path;
    }
  }
  return undefined;
}

function buildTurnInstruction(input: AgentInvokerInput): string {
  if (input.userAnswer !== undefined) {
    return `The learner answered: ${input.userAnswer}`;
  }
  if (input.skipped) {
    return "The learner skipped the question.";
  }
  return "Proceed with the current phase.";
}

function summarizeTurnHistory(turns: LearningTurn[]): string | null {
  if (turns.length === 0) {
    return null;
  }
  const lines = turns.map((turn, index) => {
    const parts = [`Q${index + 1}: ${turn.question || "(no question)"}`];
    if (turn.skipped) {
      parts.push("(skipped)");
    } else if (turn.userAnswer !== undefined) {
      parts.push(`A: ${turn.userAnswer}`);
    }
    if (turn.assessment !== undefined) {
      parts.push(`assessment: ${turn.assessment}`);
    }
    if (turn.feedback !== undefined && turn.feedback !== "") {
      parts.push(`feedback: ${turn.feedback}`);
    }
    if (turn.evidence.length > 0) {
      parts.push(
        `evidence: ${turn.evidence.map((e) => `${e.path}:${e.startLine}-${e.endLine}`).join(", ")}`,
      );
    }
    return parts.join(" | ");
  });
  return `Previous turns:\n${lines.join("\n")}`;
}
