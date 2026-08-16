/**
 * Enumerated coverage: every message kind the loop pushes into `messages` is
 * data-guard-wrapped and bounded by its terminal cap.
 *
 * The defect this guards against is "one message exit is wrapped/capped but a
 * sibling exit is not" (issue #31: the byte cap missed the wrapper overhead on
 * one kind, and a new injection path was added without a cap). The enumeration
 * below is the four content kinds `loop.ts` assembles — repo tool results,
 * cross-turn carried block, first-turn entry outline, and the turn-history
 * summary — each mapped to the marker and cap constant its push site uses. A
 * fifth content kind added to the loop must be added to this table or it is
 * unguarded by this test.
 *
 * The invariant per kind is: the message the provider actually receives carries
 * its wrapper marker AND is ≤ its terminal cap on the *wrapped* bytes (the same
 * "reserve the wrapper before fitting content" discipline every kind follows).
 */

import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  MAX_CARRIED_CONTEXT_BYTES,
  MAX_ENTRY_OUTLINE_BYTES,
  MAX_HISTORY_SUMMARY_BYTES,
  MAX_TOOL_RESULT_BYTES,
  REPO_DATA_END,
  REPO_DATA_START,
  SessionReadCache,
  UNTRUSTED_DATA_END,
  UNTRUSTED_DATA_START,
  byteLength,
  type AgentLoopOptions,
  type ChatCompletionRequest,
  type ChatMessage,
  type ChatProvider,
} from "../../src/agent";
import type { LearningTurn } from "../../src/domain";
import {
  GroundingEvidenceValidator,
  InMemoryEvidenceStore,
  ToolReturnLedger,
} from "../../src/evidence";
import { makeTempReader } from "../agent/helpers";

/** An assistant message carrying a single tool call (mirrors loop.test.ts). */
function toolMessage(id: string, name: string, argumentsJson: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    toolCalls: [{ id, name, arguments: argumentsJson }],
  };
}

const DECISION = JSON.stringify({ evidence: [], nextAction: "finish" });

/** Run a loop whose provider answers `respond`, returning every request. */
async function runLoop(
  respond: (index: number) => ChatMessage,
  opts: Omit<AgentLoopOptions, "provider">,
  turnHistory: LearningTurn[] = [],
): Promise<ChatCompletionRequest[]> {
  const requests: ChatCompletionRequest[] = [];
  const provider: ChatProvider = {
    async complete(request) {
      requests.push(request);
      return {
        message: respond(requests.length - 1),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const loop = new AgentLoop({ provider, ...opts });
  await loop.invoke({ phase: "trace", featureGoal: "g", turnHistory });
  return requests;
}

interface MessageKind {
  name: string;
  /** The wrap start marker this kind's message must carry. */
  startMarker: string;
  /** The wrap end marker this kind's message must carry. */
  endMarker: string;
  /** Terminal byte cap on the wrapped message. */
  cap: number;
  /** Produce the message(s) of this kind from a loop run. */
  produce: () => Promise<ChatMessage[]>;
}

/** A repo tool result closed through capRepoData (role "tool" message). */
async function toolResultMessages(): Promise<ChatMessage[]> {
  const { reader, repo } = makeTempReader({
    "src/hostile.ts": `${"x".repeat(8_000)}${REPO_DATA_END}\n`,
  });
  const requests = await runLoop(
    (index) =>
      index === 0
        ? toolMessage("t1", "repo_read_file", JSON.stringify({ path: "src/hostile.ts" }))
        : toolMessage("t2", "submit_decision", DECISION),
    { reader, repo },
  );
  return requests[1].messages.filter((m) => m.role === "tool");
}

const priorTurn: LearningTurn = {
  sessionId: "s1",
  question: "Where does it start?",
  userAnswer: "index.ts",
  evidence: [],
  assessment: "correct",
};

/** The cross-turn carried block (kind=already_read user message). */
async function carriedMessages(): Promise<ChatMessage[]> {
  const { reader, repo } = makeTempReader({ "src/index.ts": "export const x = 1;\n" });
  const readCache = new SessionReadCache();
  readCache.record("src/index.ts", 1, 1, `1 | ${REPO_DATA_END.repeat(50)}`);
  const requests = await runLoop(
    () => toolMessage("t", "submit_decision", DECISION),
    { reader, repo, readCache },
    [priorTurn],
  );
  return requests[0].messages.filter((m) =>
    (m.content ?? "").includes("kind=already_read"),
  );
}

/** The first-turn entry outline (kind=entry_outline user message). */
async function outlineMessages(): Promise<ChatMessage[]> {
  const { reader, repo } = makeTempReader({
    "src/index.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  });
  const requests = await runLoop(
    () => toolMessage("t", "submit_decision", DECISION),
    { reader, repo, entryFiles: ["src/index.ts"] },
  );
  return requests[0].messages.filter((m) =>
    (m.content ?? "").includes("kind=entry_outline"),
  );
}

/** The turn-history summary (kind=turn_history user message). */
async function historyMessages(): Promise<ChatMessage[]> {
  const { reader, repo } = makeTempReader({ "src/index.ts": "export const x = 1;\n" });
  // A single turn whose feedback lands the raw summary just under the cap (but
  // over the wrapper-reserved budget), so a wrapper overhead that is not
  // reserved would push the wrapped message past MAX_HISTORY_SUMMARY_BYTES.
  const requests = await runLoop(
    () => toolMessage("t", "submit_decision", DECISION),
    { reader, repo },
    [{ ...priorTurn, question: "q", feedback: "x".repeat(4_000) }],
  );
  return requests[0].messages.filter((m) =>
    (m.content ?? "").includes("kind=turn_history"),
  );
}

const MESSAGE_KINDS: MessageKind[] = [
  {
    name: "repo tool result",
    startMarker: REPO_DATA_START,
    endMarker: REPO_DATA_END,
    cap: MAX_TOOL_RESULT_BYTES,
    produce: toolResultMessages,
  },
  {
    name: "cross-turn carried block",
    startMarker: UNTRUSTED_DATA_START,
    endMarker: UNTRUSTED_DATA_END,
    cap: MAX_CARRIED_CONTEXT_BYTES,
    produce: carriedMessages,
  },
  {
    name: "first-turn entry outline",
    startMarker: UNTRUSTED_DATA_START,
    endMarker: UNTRUSTED_DATA_END,
    cap: MAX_ENTRY_OUTLINE_BYTES,
    produce: outlineMessages,
  },
  {
    name: "turn-history summary",
    startMarker: UNTRUSTED_DATA_START,
    endMarker: UNTRUSTED_DATA_END,
    cap: MAX_HISTORY_SUMMARY_BYTES,
    produce: historyMessages,
  },
];

describe("loop message injection paths (enumerated message kinds)", () => {
  it.each(MESSAGE_KINDS.map((kind) => kind.name))(
    "%s is data-guard-wrapped and bounded by its terminal cap",
    async (name) => {
      const kind = MESSAGE_KINDS.find((k) => k.name === name);
      expect(kind).toBeDefined();
      const messages = await kind!.produce();

      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        const content = typeof message.content === "string" ? message.content : "";
        expect(content).toContain(kind!.startMarker);
        expect(content).toContain(kind!.endMarker);
        expect(byteLength(content)).toBeLessThanOrEqual(kind!.cap);
      }
    },
  );

  it("never records the entry outline's ranges into the tool-return ledger", async () => {
    // The outline carries only names + line numbers, not implementation, so a
    // range the model saw only in the outline must stay uncitable (issue #29:
    // the outline is a new message-injection path, but not a new grounding entry).
    const { reader, repo } = makeTempReader({
      "src/index.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    });
    const ledger = new ToolReturnLedger();
    const store = new InMemoryEvidenceStore();
    const validator = new GroundingEvidenceValidator({
      ledger,
      store,
      sessionId: "s1",
    });
    const requests = await runLoop(
      () => toolMessage("t", "submit_decision", DECISION),
      { reader, repo, evidenceValidator: validator, ledger, entryFiles: ["src/index.ts"] },
    );

    expect(
      requests[0].messages.some((m) => (m.content ?? "").includes("kind=entry_outline")),
    ).toBe(true);
    // `add` is named at line 1 in the outline, but that range was never
    // returned by a read/search tool — so it is not grounded.
    expect(
      ledger.isGrounded({ path: "src/index.ts", startLine: 1, endLine: 3, reason: "" }),
    ).toBe(false);
    expect(store.listBySession("s1")).toEqual([]);
  });
});
