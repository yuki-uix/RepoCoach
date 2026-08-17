/**
 * Enumerated coverage: every message kind the loop pushes into `messages` is
 * data-guard-wrapped and bounded by its terminal cap.
 *
 * The defect this guards against is "one message exit is wrapped/capped but a
 * sibling exit is not" (issue #31: the byte cap missed the wrapper overhead on
 * one kind, and a new injection path was added without a cap). The enumeration
 * here is NOT a hand-written array of the four kinds — it is
 * `INJECTED_MESSAGE_KINDS`, the single registry the loop and its builders read
 * their cap and data-guard `kind` string from (message-kinds.ts). A fifth
 * content kind added to the loop must be registered there first (the accessor
 * throws on an unknown id), which makes the guards below fail until a producer
 * is added — the list can never silently drift to "still testing four".
 *
 * The invariant per kind is: the message the provider actually receives carries
 * its wrapper marker AND is ≤ its terminal cap on the *wrapped* bytes (the same
 * "reserve the wrapper before fitting content" discipline every kind follows).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  INJECTED_MESSAGE_KINDS,
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

/** The modules that assemble data-guard-wrapped messages for the loop. */
const ASSEMBLY_FILES = ["loop.ts", "entry-outline.ts", "read-cache.ts"] as const;

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

/** A producer for each registered kind, keyed by the registry's stable id. */
const PRODUCERS: Record<string, () => Promise<ChatMessage[]>> = {
  repo_tool_result: toolResultMessages,
  already_read: carriedMessages,
  entry_outline: outlineMessages,
  turn_history: historyMessages,
};

describe("loop message injection paths (enumerated from INJECTED_MESSAGE_KINDS)", () => {
  it("injects exactly the registered kinds — a missed registration fails here", () => {
    // The assembly modules may only inject a message kind through the registry
    // accessor `injectedMessageKind("<id>")`, which throws on an unknown id, so
    // a new injection site must first register its kind. Scan those modules and
    // require the ids they reference to equal the registry exactly: an id
    // referenced but not registered, or registered but never referenced, both
    // fail this assertion.
    const referenced = new Set<string>();
    for (const file of ASSEMBLY_FILES) {
      const source = readFileSync(new URL(`../../src/agent/${file}`, import.meta.url), "utf8");
      for (const match of source.matchAll(/injectedMessageKind\(\s*"([^"]+)"/g)) {
        referenced.add(match[1]);
      }
    }
    expect([...referenced].sort()).toEqual(INJECTED_MESSAGE_KINDS.map((k) => k.kind).sort());
  });

  it("has a producer for exactly the registered kinds", () => {
    // Same set-equality guard as the tool-exit suite: a kind added to the
    // registry without a producer (or a producer left behind after a kind is
    // removed) fails here instead of being silently skipped by the enumeration.
    expect(Object.keys(PRODUCERS).sort()).toEqual(
      INJECTED_MESSAGE_KINDS.map((k) => k.kind).sort(),
    );
  });

  it("records a wrapper consistent with each kind's markers", () => {
    // The registry's `wrapper` field must agree with the marker pair it names;
    // a mislabeled kind would otherwise assert the wrong boundary in the wrap
    // test below.
    for (const kind of INJECTED_MESSAGE_KINDS) {
      if (kind.wrapper === "repo_data") {
        expect(kind.startMarker).toBe(REPO_DATA_START);
        expect(kind.endMarker).toBe(REPO_DATA_END);
      } else {
        expect(kind.startMarker).toBe(UNTRUSTED_DATA_START);
        expect(kind.endMarker).toBe(UNTRUSTED_DATA_END);
      }
    }
  });

  for (const kind of INJECTED_MESSAGE_KINDS) {
    it(`${kind.name} is data-guard-wrapped and bounded by its terminal cap`, async () => {
      const produce = PRODUCERS[kind.kind];
      expect(produce).toBeDefined();
      const messages = await produce();

      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        const content = typeof message.content === "string" ? message.content : "";
        expect(content).toContain(kind.startMarker);
        expect(content).toContain(kind.endMarker);
        expect(byteLength(content)).toBeLessThanOrEqual(kind.cap);
      }
    });
  }

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
