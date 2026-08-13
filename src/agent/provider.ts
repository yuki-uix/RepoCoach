/**
 * Chat provider seam — an OpenAI-compatible chat-completions shape.
 *
 * A minimal, SDK-free set of types for the request/response the agent loop
 * needs (messages, function calling, streaming). The DeepSeek provider is one
 * implementation; tests substitute a mock. See docs/architecture.md §3.
 */

import type { TokenUsage } from "../domain/index.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A single function call the assistant requested. */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string (function-calling wire format). */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  /** Text content; null on assistant tool-call turns and empty text. */
  content: string | null;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool messages, linking back to the assistant's call id. */
  toolCallId?: string;
}

export interface FunctionTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: FunctionTool;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

export interface ChatCompletionResult {
  message: ChatMessage;
  usage: TokenUsage;
}

/** Streaming event a provider may emit while a completion is in flight. */
export type ChatProviderEvent = { type: "text_delta"; delta: string };

export interface ChatProvider {
  complete(
    request: ChatCompletionRequest,
    onEvent?: (event: ChatProviderEvent) => void,
  ): Promise<ChatCompletionResult>;
}

/** Convert an internal message to the OpenAI-compatible wire shape. */
export function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCalls !== undefined) {
    wire.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.arguments },
    }));
  }
  if (message.toolCallId !== undefined) {
    wire.tool_call_id = message.toolCallId;
  }
  return wire;
}
