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
  capRepoData,
  escapedByteLength,
  repoDataWrapperOverhead,
  wrapUntrustedContext,
  type RepoDataMeta,
} from "./data-guard.js";
import { DEFAULT_DEEPSEEK_MODEL } from "./deepseek-provider.js";
import { formatZodError } from "./errors.js";
import { parseJsonLenient, unwrapToolArguments } from "./json-repair.js";
import {
  MAX_CARRIED_CONTEXT_BYTES,
  MAX_HISTORY_SUMMARY_BYTES,
  MAX_TOOL_RESULT_BYTES,
  byteLength,
} from "./limits.js";
import type { AgentLogger } from "./logger.js";
import { noopLogger } from "./logger.js";
import type {
  ChatMessage,
  ChatProvider,
  ChatProviderEvent,
  ToolCall,
  ToolDefinition,
} from "./provider.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createToolRegistry,
  type EvidenceValidator,
  type ToolRegistry,
} from "./tools.js";
import { SessionReadCache, buildCarriedBlock } from "./read-cache.js";
import { buildEntryOutline, type EntryOutline } from "./entry-outline.js";

export const DEFAULT_MAX_TOOL_ROUNDS = 15;
export const MAX_DECISION_RETRIES = 2;

/**
 * Thrown when the model never produces a schema-valid decision. Carries the
 * provider usage the loop accumulated before failing, so the caller can still
 * count tokens a failed call actually spent (failed calls cost real tokens).
 */
export class AgentDecisionInvalidError extends Error {
  readonly usage: TokenUsage;
  constructor(message: string, usage: TokenUsage) {
    super(message);
    this.name = "AgentDecisionInvalidError";
    this.usage = usage;
  }
}

export type AgentLoopEvent =
  | { type: "tool_call_started"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "text_delta"; delta: string }
  | { type: "decision_submitted"; decision: AgentDecision }
  | {
      type: "read_file_content";
      path: string;
      startLine: number;
      endLine: number;
      /** 0-based turn index the read happened in. */
      turnIndex: number;
    }
  | { type: "carried_context"; bytes: number; turnIndex: number }
  | { type: "entry_outline"; bytes: number; turnIndex: number };

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
  /**
   * Session-level record of already-read file ranges, carried across turns so
   * the model does not re-read the same files every turn (issue #25). Defaults
   * to a fresh in-memory cache when not injected — a resumed session rebuilds
   * it empty, so its first turn re-reads (see read-cache.ts).
   */
  readCache?: SessionReadCache;
  /**
   * Whether to carry already-read ranges into later turns' context (issue #25).
   * Defaults to true; `false` reproduces the pre-optimisation behaviour exactly
   * (no carried block, no `recordCarried`) so the same instrumentation can
   * measure both arms of the A/B comparison.
   */
  carryReadContext?: boolean;
  /**
   * Entry files of the feature being learned (from the selected candidate).
   * When set, the first turn preloads a byte-capped structure outline of their
   * top-level exported symbols (names + line numbers) so the model can locate
   * symbols without exploratory searches (issue #29). The outline is
   * data-guard-wrapped and never recorded into the ledger.
   */
  entryFiles?: string[];
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
      "Submit your structured decision to end the turn. This is the only way to finish. Before citing package.json or any file content as evidence, you must first repo_read_file that range.",
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
  private readonly readCache: SessionReadCache;
  private readonly carryReadContext: boolean;
  private readonly entryFiles?: string[];
  private readonly reader: Reader;
  private readonly repo: Repository;
  private readonly logger: AgentLogger;
  private readonly onEvent?: (event: AgentLoopEvent) => void;
  private readonly allTools: ToolDefinition[];
  /** 0-based turn index of the invoke currently running (set at invoke start). */
  private currentTurnIndex = 0;
  /** Memoized first-turn entry outline; built lazily once per loop instance. */
  private entryOutline: Promise<EntryOutline | null> | undefined;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.evidenceValidator = options.evidenceValidator;
    this.ledger = options.ledger;
    this.readCache = options.readCache ?? new SessionReadCache();
    this.carryReadContext = options.carryReadContext ?? true;
    this.entryFiles = options.entryFiles;
    this.reader = options.reader;
    this.repo = options.repo;
    this.tools = createToolRegistry({
      reader: options.reader,
      repo: options.repo,
      evidenceValidator: options.evidenceValidator,
      returnRecorder: options.ledger,
      readCache: this.readCache,
      onContentRead: (path, startLine, endLine) =>
        this.emit({
          type: "read_file_content",
          path,
          startLine,
          endLine,
          turnIndex: this.currentTurnIndex,
        }),
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
    this.currentTurnIndex = input.turnHistory.length;
    this.ledger?.resetTurn();
    this.evidenceValidator?.setTurnIndex?.(input.turnHistory.length);
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const collectedEvidence: Evidence[] = [];
    const messages = await this.buildInitialMessages(input);

    let decisionRetries = 0;
    let forceMessageAdded = false;
    const maxRounds = this.maxToolRounds + this.maxDecisionRetries + 2;

    // Shared rejection path for both schema and grounding failures: feed the
    // corrective message back as a tool result and retry, or throw once the
    // retry budget is exhausted.
    const rejectDecision = (toolCall: ToolCall, message: string): void => {
      decisionRetries += 1;
      if (decisionRetries > this.maxDecisionRetries) {
        throw new AgentDecisionInvalidError(
          `Decision failed validation after ${this.maxDecisionRetries} retries: ${message}`,
          usage,
        );
      }
      this.emit({ type: "tool_result", name: "submit_decision", result: message });
      this.logger.warn("agent decision rejected", { message });
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: message,
      });
    };

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
            usage,
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
            // Ground each cited range at the exit, not only at repo_save_evidence:
            // the model must not bypass constructive grounding by submitting
            // fabricated evidence straight into submit_decision.
            const groundingError = this.validateDecisionEvidence(outcome.decision);
            if (groundingError === null) {
              // The accepted citations are the ranges the model keeps referring
              // back to; mark them so the carry budget keeps them next turn.
              for (const evidence of outcome.decision.evidence) {
                this.readCache.markCited(
                  evidence.path,
                  evidence.startLine,
                  evidence.endLine,
                );
              }
              this.emit({ type: "decision_submitted", decision: outcome.decision });
              this.logger.info("agent decision submitted", {
                nextAction: outcome.decision.nextAction,
              });
              return { decision: outcome.decision, usage };
            }
            rejectDecision(toolCall, groundingError);
            continue;
          }

          rejectDecision(toolCall, outcome.message);
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
            content: capRepoData(stray, { tool: toolCall.name }, MAX_TOOL_RESULT_BYTES),
          });
          continue;
        }

        const args = parseArguments(toolCall.arguments);
        const meta: RepoDataMeta = {
          tool: toolCall.name,
          path: pathOfTool(toolCall.name, args),
        };
        // ENDPOINT CONSTRAINT: this is the single place a repo tool result
        // becomes a `messages` entry. Whatever the tools returned is wrapped
        // here, so the final message size is enforced *here* on the wrapped
        // string — endpoint constraint beats per-stage accounting. The tools
        // bill their escaped payload against `maxBytes` (the wrapper overhead
        // already reserved off MAX_TOOL_RESULT_BYTES), and `capRepoData` is the
        // final guarantee the assembled content never exceeds it. Message kinds
        // capped at assembly:
        //   - repo tool results (read/search/tree/package-info/save-evidence +
        //     error results) → MAX_TOOL_RESULT_BYTES via capRepoData;
        //   - cross-turn carried block → MAX_CARRIED_CONTEXT_BYTES via
        //     buildCarriedBlock (already wraps + hard-caps before this point).
        const result =
          args === undefined
            ? "Error: tool arguments are not valid JSON"
            : await this.tools.execute({
                name: toolCall.name,
                args,
                collectedEvidence,
                maxBytes: MAX_TOOL_RESULT_BYTES - repoDataWrapperOverhead(meta),
              });
        this.emit({ type: "tool_result", name: toolCall.name, result });
        this.logger.debug("agent tool result", { tool: toolCall.name });
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: capRepoData(result, meta, MAX_TOOL_RESULT_BYTES),
        });
      }
    }

    throw new AgentDecisionInvalidError(
      `Agent loop exceeded ${maxRounds} rounds without a valid decision`,
      usage,
    );
  }

  private async buildInitialMessages(input: AgentInvokerInput): Promise<ChatMessage[]> {
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
    // First turn only: preload a structural outline of the candidate's entry
    // files so the model locates symbols without exploratory searches (issue
    // #29). The block is already UNTRUSTED_DATA-wrapped (and hard-capped at
    // MAX_ENTRY_OUTLINE_BYTES) inside the builder, so it is pushed verbatim.
    if (input.turnHistory.length === 0) {
      const outline = await this.entryOutlineBlock();
      if (outline !== null) {
        messages.push({ role: "user", content: outline.content });
        this.emit({ type: "entry_outline", bytes: outline.bytes, turnIndex: 0 });
      }
    }
    const carried = this.buildCarriedContextBlock(input.turnHistory.length);
    if (carried !== null) {
      // Already UNTRUSTED_DATA-wrapped (and hard-capped) inside the builder, so
      // it is pushed verbatim rather than wrapped a second time here.
      messages.push({ role: "user", content: carried });
    }
    messages.push({ role: "user", content: buildTurnInstruction(input) });
    return messages;
  }

  /**
   * Build (and memoize) the first-turn entry outline. Returns null when no
   * entry files are configured or none resolve to exported symbols. An outline
   * failure is non-fatal — it is a navigation aid, never a requirement — so the
   * builder's own per-file error handling plus this catch keeps it from ever
   * aborting a turn.
   */
  private entryOutlineBlock(): Promise<EntryOutline | null> {
    if (this.entryFiles === undefined || this.entryFiles.length === 0) {
      return Promise.resolve(null);
    }
    if (this.entryOutline === undefined) {
      this.entryOutline = buildEntryOutline(this.reader, this.repo, this.entryFiles).catch(
        () => null,
      );
    }
    return this.entryOutline;
  }

  /**
   * Build the cross-turn "already-read" context block for turn 2 onward. Carries
   * a byte-bounded subset of the session read cache with full content (recording
   * exactly those ranges into the ledger as context-carried, so they become
   * citable without a re-read) and downgrades the rest to path + line range.
   * Returns null on the first turn or when the cache is empty.
   */
  private buildCarriedContextBlock(turnIndex: number): string | null {
    // The carry can be switched off (eval --no-carry) to reproduce the exact
    // pre-#25 behaviour: no carried block is injected and nothing is recorded
    // as carried, so the same instrumentation measures both arms of the A/B.
    if (!this.carryReadContext || turnIndex === 0 || this.readCache.ranges.length === 0) {
      return null;
    }
    const built = buildCarriedBlock(this.readCache.ranges, MAX_CARRIED_CONTEXT_BYTES);
    // Only the ranges whose content actually landed in context are citable —
    // `buildCarriedBlock` returns exactly those after its hard cap, so any entry
    // it dropped is never recorded as carried (the model never saw its content).
    for (const range of built.carried) {
      this.ledger?.recordCarried(range.path, range.startLine, range.endLine);
    }
    this.emit({ type: "carried_context", bytes: byteLength(built.content), turnIndex });
    return built.content;
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
    const raw = parseJsonLenient(argumentsJson);
    if (!raw.ok) {
      return {
        kind: "error",
        message: `submit_decision 的参数不是合法 JSON：${raw.message}。请重新发送合法的 JSON 对象（不要在外层包裹 arguments/input/parameters 键）。`,
      };
    }
    // The model sometimes double-wraps the decision as {"arguments": {...}};
    // unwrap a single-layer wrapper before schema validation.
    const parsed = agentDecisionSchema.safeParse(unwrapToolArguments(raw.value));
    if (!parsed.success) {
      return {
        kind: "error",
        message: `Decision rejected by schema: ${formatZodError(parsed.error)}`,
      };
    }
    return { kind: "ok", decision: parsed.data };
  }

  /**
   * Ground every cited range at the submit_decision exit so the model cannot
   * skip repo_save_evidence and submit fabricated evidence directly. Returns
   * null when every claim passes (or no validator is configured); otherwise a
   * corrective message naming each rejected claim.
   */
  private validateDecisionEvidence(decision: AgentDecision): string | null {
    if (this.evidenceValidator === undefined) {
      return null;
    }
    const rejections: string[] = [];
    for (const evidence of decision.evidence) {
      const verdict = this.evidenceValidator.validate(evidence);
      if (!verdict.ok) {
        rejections.push(verdict.reason);
      }
    }
    if (rejections.length === 0) {
      return null;
    }
    return `Decision rejected: evidence not grounded:\n${rejections.join("\n")}`;
  }

  private emit(event: AgentLoopEvent): void {
    this.onEvent?.(event);
  }
}

function parseArguments(argumentsJson: string): unknown | undefined {
  const parsed = parseJsonLenient(argumentsJson);
  if (!parsed.ok) {
    return undefined;
  }
  return unwrapToolArguments(parsed.value);
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

export function summarizeTurnHistory(turns: LearningTurn[]): string | null {
  if (turns.length === 0) {
    return null;
  }
  const prefix = "Previous turns:\n";
  const full = `${prefix}${turns.map(formatTurnLine).join("\n")}`;
  // Turn fields are model-generated from repo content, so they are later
  // escaped by `wrapUntrustedContext`. Bill their escaped size, or marker-heavy
  // feedback/question text would inflate past the cap after escaping.
  if (escapedByteLength(full) <= MAX_HISTORY_SUMMARY_BYTES) {
    return full;
  }
  // Cap the summary: keep the most recent turns in full and collapse the older
  // ones into a single marker so a long session stops re-sending every word.
  // Reserve the marker's maximum length up front (its digit count grows with
  // `omitted`, so it can never exceed the marker for `turns.length`); without
  // that reservation the marker pushes the joined string over the cap.
  const maxOlderBytes = byteLength(`… ${turns.length} earlier turn(s) omitted (see session file)\n`);
  const budget = MAX_HISTORY_SUMMARY_BYTES - byteLength(prefix) - maxOlderBytes;
  const kept: string[] = [];
  let keptBytes = 0;
  let index = turns.length - 1;
  while (index >= 0) {
    const line = formatTurnLine(turns[index]!, index);
    const separator = kept.length === 0 ? 0 : 1;
    if (escapedByteLength(line) + separator + keptBytes > budget) {
      break;
    }
    kept.unshift(line);
    keptBytes += escapedByteLength(line) + separator;
    index -= 1;
  }
  const omitted = index + 1;
  const older = omitted > 0 ? `… ${omitted} earlier turn(s) omitted (see session file)\n` : "";
  return `${prefix}${older}${kept.join("\n")}`;
}

function formatTurnLine(turn: LearningTurn, index: number): string {
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
}
