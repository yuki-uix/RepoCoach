import { describe, expect, it } from "vitest";
import {
  DeepSeekProvider,
  parseChunkLine,
  type AgentLogger,
  type ChatProviderEvent,
} from "../../src/agent";
import { sseLine, sseResponse } from "./helpers";

const KEY = "sk-fake-secret-key";

function makeProvider(overrides: {
  key?: string;
  fetchFn?: typeof fetch;
  logger?: AgentLogger;
} = {}): DeepSeekProvider {
  return new DeepSeekProvider({
    apiKey: overrides.key ?? KEY,
    fetchFn: overrides.fetchFn,
    logger: overrides.logger,
  });
}

/** SSE for a turn that streams text, a repo_read_file tool call, and usage. */
function toolCallStreamText(): string {
  return [
    sseLine({ id: "1", choices: [{ index: 0, delta: { role: "assistant", content: "Let" } }] }),
    sseLine({ id: "1", choices: [{ index: 0, delta: { content: " me check." } }] }),
    sseLine({
      id: "1",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "repo_read_file", arguments: "" } },
            ],
          },
        },
      ],
    }),
    sseLine({
      id: "1",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
    }),
    sseLine({
      id: "1",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"src/index.ts"}' } }] } }],
    }),
    sseLine({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseLine({ id: "1", choices: [], usage: { prompt_tokens: 12, completion_tokens: 9 } }),
    "data: [DONE]\n\n",
  ].join("");
}

async function completeToolCallStream(chunkSize?: number) {
  const provider = makeProvider({
    fetchFn: async () => sseResponse(toolCallStreamText(), chunkSize),
  });
  return provider.complete({ model: "deepseek-v4-flash", messages: [] });
}

describe("DeepSeekProvider SSE parsing", () => {
  it("assembles text, tool calls and usage from a single stream", async () => {
    const result = await completeToolCallStream();

    expect(result.message.content).toBe("Let me check.");
    expect(result.message.toolCalls).toEqual([
      { id: "call_1", name: "repo_read_file", arguments: '{"path":"src/index.ts"}' },
    ]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
  });

  it("assembles correctly when chunks split mid-line and mid-token", async () => {
    const result = await completeToolCallStream(7);

    expect(result.message.content).toBe("Let me check.");
    expect(result.message.toolCalls).toEqual([
      { id: "call_1", name: "repo_read_file", arguments: '{"path":"src/index.ts"}' },
    ]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
  });

  it("emits text_delta events as content arrives", async () => {
    const deltas: string[] = [];
    const onEvent = (event: ChatProviderEvent): void => {
      deltas.push(event.delta);
    };
    const provider = makeProvider({
      fetchFn: async () => sseResponse(toolCallStreamText()),
    });

    await provider.complete({ model: "deepseek-v4-flash", messages: [] }, onEvent);

    expect(deltas.join("")).toBe("Let me check.");
  });

  it("ignores the [DONE] sentinel, blank lines and non-JSON payloads", () => {
    expect(parseChunkLine("[DONE]")).toBeNull();
    expect(parseChunkLine("")).toBeNull();
    expect(parseChunkLine("not-json")).toBeNull();
  });
});

describe("DeepSeekProvider error handling", () => {
  it("throws with status code and a key-redacted body snippet", async () => {
    const provider = makeProvider({
      fetchFn: async () =>
        new Response(
          JSON.stringify({ error: { message: `invalid api key ${KEY}` } }),
          { status: 401 },
        ),
    });

    let thrown = "";
    try {
      await provider.complete({ model: "deepseek-v4-flash", messages: [] });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    expect(thrown).toMatch(/DeepSeek API error 401/);
    expect(thrown).toContain("[REDACTED]");
    expect(thrown).not.toContain(KEY);
  });

  it("does not leak an empty key when redacting", async () => {
    const provider = makeProvider({
      key: "",
      fetchFn: async () => new Response("boom", { status: 500 }),
    });

    await expect(
      provider.complete({ model: "deepseek-v4-flash", messages: [] }),
    ).rejects.toThrow(/DeepSeek API error 500: boom/);
  });

  it("redacts the key from fetch failures without leaking it through the cause chain", async () => {
    const provider = makeProvider({
      fetchFn: async () => {
        throw new Error(`network failure: Authorization Bearer ${KEY} rejected`);
      },
    });

    let thrown: unknown;
    try {
      await provider.complete({ model: "deepseek-v4-flash", messages: [] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/DeepSeek request failed/);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(KEY);

    // The raw error echoed the Authorization header; the cause chain must not
    // carry it through unredacted.
    let cause: unknown = (thrown as Error).cause;
    while (cause !== undefined) {
      const causeText = cause instanceof Error ? cause.message : String(cause);
      expect(causeText).not.toContain(KEY);
      cause = cause instanceof Error ? cause.cause : undefined;
    }
  });
});

describe("DeepSeekProvider request shape", () => {
  it("sends an OpenAI-compatible streaming request", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      captured = { url: String(url), init };
      return sseResponse(
        sseLine({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      );
    };

    await makeProvider({ fetchFn }).complete({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c1", name: "repo_get_tree", arguments: "{}" }],
        },
      ],
    });

    expect(captured?.url).toBe("https://api.deepseek.com/chat/completions");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);

    const body = JSON.parse(String(captured?.init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("deepseek-v4-flash");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1].tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "repo_get_tree", arguments: "{}" } },
    ]);
  });
});
