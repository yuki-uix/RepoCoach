/**
 * DeepSeek chat-completions provider (OpenAI-compatible).
 *
 * Streams SSE from https://api.deepseek.com/chat/completions, incrementally
 * assembling text and tool-call arguments. The API key is passed in via the
 * constructor (never read from disk here — src/config.ts owns that) and is
 * redacted from every thrown error message so it cannot leak through an
 * echoed response body into logs.
 */

import type { TokenUsage } from "../domain/index.js";
import { describeError } from "./errors.js";
import type { AgentLogger } from "./logger.js";
import { noopLogger } from "./logger.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatProvider,
  ChatProviderEvent,
  ToolCall,
} from "./provider.js";
import { toWireMessage } from "./provider.js";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export interface DeepSeekProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Test seam — inject fetch. */
  fetchFn?: typeof fetch;
  logger?: AgentLogger;
}

/** One parsed SSE `data:` line: a content/tool-call delta plus optional usage. */
export interface ChunkDelta {
  content?: string;
  tool_calls?: ChunkToolCallDelta[];
}

export interface ChunkToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface ChunkUsage {
  inputTokens: number;
  outputTokens: number;
}

export class DeepSeekProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger: AgentLogger;

  constructor(options: DeepSeekProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_DEEPSEEK_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger ?? noopLogger;
  }

  async complete(
    request: ChatCompletionRequest,
    onEvent?: (event: ChatProviderEvent) => void,
  ): Promise<ChatCompletionResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: request.model ?? this.model,
      messages: request.messages.map(toWireMessage),
      tools: request.tools,
      stream: true,
      stream_options: { include_usage: true },
    };

    this.logger.debug("DeepSeekProvider: request", {
      model: body.model,
      toolCount: request.tools?.length ?? 0,
    });

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`DeepSeek request failed: ${describeError(error)}`, {
        cause: error,
      });
    }

    if (!response.ok) {
      const text = await readErrorBody(response);
      const message = `DeepSeek API error ${response.status}: ${redact(
        text.slice(0, 200),
        this.apiKey,
      )}`;
      this.logger.error("DeepSeekProvider: non-2xx response", {
        status: response.status,
      });
      throw new Error(message);
    }

    if (response.body === null) {
      throw new Error("DeepSeek API returned an empty response body");
    }

    const { message, usage } = await assembleSseStream(response.body, onEvent);
    this.logger.debug("DeepSeekProvider: response", { usage });
    return { message, usage };
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Replace every occurrence of a secret with a placeholder (no-op when empty). */
export function redact(text: string, secret: string): string {
  if (secret === "") {
    return text;
  }
  return text.split(secret).join("[REDACTED]");
}

/**
 * Parse one `data:` payload line into a delta plus optional usage. Returns
 * null for the `[DONE]` sentinel, blank input, or an unparseable line.
 */
export function parseChunkLine(
  data: string,
): { delta: ChunkDelta; usage?: ChunkUsage } | null {
  const trimmed = data.trim();
  if (trimmed === "" || trimmed === "[DONE]") {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) {
    return null;
  }

  const root = json as Record<string, unknown>;
  const delta: ChunkDelta = {};

  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0];
    if (typeof choice === "object" && choice !== null) {
      const rawDelta = (choice as Record<string, unknown>).delta;
      if (typeof rawDelta === "object" && rawDelta !== null) {
        const d = rawDelta as Record<string, unknown>;
        if (typeof d.content === "string") {
          delta.content = d.content;
        }
        if (Array.isArray(d.tool_calls)) {
          const toolCalls = d.tool_calls
            .map(parseToolCallDelta)
            .filter((tc): tc is ChunkToolCallDelta => tc !== null);
          if (toolCalls.length > 0) {
            delta.tool_calls = toolCalls;
          }
        }
      }
    }
  }

  const rawUsage = root.usage;
  let usage: ChunkUsage | undefined;
  if (typeof rawUsage === "object" && rawUsage !== null) {
    const u = rawUsage as Record<string, unknown>;
    const inputTokens = asNonNegativeInt(u.prompt_tokens);
    const outputTokens = asNonNegativeInt(u.completion_tokens);
    if (inputTokens !== undefined && outputTokens !== undefined) {
      usage = { inputTokens, outputTokens };
    }
  }

  return { delta, usage };
}

function parseToolCallDelta(value: unknown): ChunkToolCallDelta | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const tc = value as Record<string, unknown>;
  if (typeof tc.index !== "number") {
    return null;
  }
  const out: ChunkToolCallDelta = { index: tc.index };
  if (typeof tc.id === "string") {
    out.id = tc.id;
  }
  const fn = tc.function;
  if (typeof fn === "object" && fn !== null) {
    const f = fn as Record<string, unknown>;
    if (typeof f.name === "string") {
      out.name = f.name;
    }
    if (typeof f.arguments === "string") {
      out.arguments = f.arguments;
    }
  }
  return out;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Incrementally assemble text + tool calls from an SSE body stream. */
export async function assembleSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (event: ChatProviderEvent) => void,
): Promise<{ message: ChatMessage; usage: TokenUsage }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const assembler = new SseAssembler();
  let buffer = "";

  const processDataLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const parsed = parseChunkLine(trimmed.slice("data:".length).trim());
    if (parsed === null) {
      return;
    }
    assembler.push(parsed.delta, parsed.usage, onEvent);
  };

  const processBuffered = (): void => {
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      processDataLine(line);
      newline = buffer.indexOf("\n");
    }
  };

  let chunk = await reader.read();
  while (!chunk.done) {
    buffer += decoder.decode(chunk.value, { stream: true });
    processBuffered();
    chunk = await reader.read();
  }
  buffer += decoder.decode();
  processBuffered();
  if (buffer.trim() !== "") {
    processDataLine(buffer);
  }

  return assembler.finish();
}

class SseAssembler {
  private content = "";
  private readonly toolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  push(
    delta: ChunkDelta,
    usage?: ChunkUsage,
    onEvent?: (event: ChatProviderEvent) => void,
  ): void {
    if (delta.content !== undefined) {
      this.content += delta.content;
      onEvent?.({ type: "text_delta", delta: delta.content });
    }
    for (const toolCall of delta.tool_calls ?? []) {
      const slot = this.toolCalls.get(toolCall.index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      if (toolCall.id !== undefined) {
        slot.id = toolCall.id;
      }
      if (toolCall.name !== undefined) {
        slot.name = toolCall.name;
      }
      if (toolCall.arguments !== undefined) {
        slot.arguments += toolCall.arguments;
      }
      this.toolCalls.set(toolCall.index, slot);
    }
    if (usage !== undefined) {
      this.usage = usage;
    }
  }

  finish(): { message: ChatMessage; usage: TokenUsage } {
    const toolCalls: ToolCall[] = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => ({
        id: slot.id,
        name: slot.name,
        arguments: slot.arguments,
      }));

    return {
      message: {
        role: "assistant",
        content: this.content === "" ? null : this.content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage: { ...this.usage },
    };
  }
}
