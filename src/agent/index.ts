/**
 * Agent Loop — public entry point.
 *
 * Composes the DeepSeek provider, the read-only repo tools, the data-guard
 * wrapping and the self-implemented tool loop into one import surface. See
 * docs/architecture.md §3.
 */

import type { AgentInvoker } from "../orchestrator/orchestrator.js";
import type { AgentLoop } from "./loop.js";

export {
  AgentDecisionInvalidError,
  AgentLoop,
  DEFAULT_MAX_TOOL_ROUNDS,
  MAX_DECISION_RETRIES,
} from "./loop.js";
export type { AgentLoopEvent, AgentLoopOptions } from "./loop.js";

export {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DeepSeekProvider,
  assembleSseStream,
  parseChunkLine,
  redact,
} from "./deepseek-provider.js";
export type {
  ChunkDelta,
  ChunkToolCallDelta,
  ChunkUsage,
  DeepSeekProviderOptions,
} from "./deepseek-provider.js";

export { buildSystemPrompt } from "./system-prompt.js";

export {
  REPO_DATA_END,
  REPO_DATA_START,
  REPO_DATA_WARNING,
  UNTRUSTED_DATA_END,
  UNTRUSTED_DATA_START,
  UNTRUSTED_DATA_WARNING,
  escapeDataMarkers,
  wrapRepoData,
  wrapUntrustedContext,
} from "./data-guard.js";
export type { RepoDataMeta, UntrustedContextMeta } from "./data-guard.js";

export { acceptAllEvidence, createToolRegistry } from "./tools.js";
export type {
  EvidenceValidator,
  ToolExecution,
  ToolRegistry,
  ToolRuntime,
} from "./tools.js";

export { noopLogger } from "./logger.js";
export type { AgentLogger } from "./logger.js";

export { describeError, formatZodError } from "./errors.js";

export { toWireMessage } from "./provider.js";
export type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatProvider,
  ChatProviderEvent,
  ChatRole,
  FunctionTool,
  ToolCall,
  ToolDefinition,
} from "./provider.js";

/** Adapt an AgentLoop into the Orchestrator's `AgentInvoker` function seam. */
export function toInvoker(loop: AgentLoop): AgentInvoker {
  return (input) => loop.invoke(input);
}
