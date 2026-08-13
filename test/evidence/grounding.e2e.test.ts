import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentDecisionInvalidError,
  AgentLoop,
  type ChatCompletionRequest,
  type ChatMessage,
  type ChatProvider,
} from "../../src/agent";
import {
  GroundingEvidenceValidator,
  InMemoryEvidenceStore,
  ToolReturnLedger,
} from "../../src/evidence";
import { createReader, type Repository } from "../../src/reader";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");

function toolMessage(id: string, name: string, args: unknown): ChatMessage {
  return {
    role: "assistant",
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}

/** A validator wired to a fresh reader/ledger/store plus a request log. */
function groundingHarness() {
  const reader = createReader({
    cacheRoot: mkdtempSync(join(tmpdir(), "repocoach-cache-")),
  });
  const repo: Repository = {
    source: { kind: "local", path: fixtureRoot },
    rootDir: fixtureRoot,
    sha: "fixture",
    meta: null,
  };
  const ledger = new ToolReturnLedger();
  const store = new InMemoryEvidenceStore();
  const validator = new GroundingEvidenceValidator({
    ledger,
    store,
    sessionId: "s1",
  });
  const requests: ChatCompletionRequest[] = [];
  return { reader, repo, ledger, store, validator, requests };
}

/** A loop that replays `responses` verbatim, one per provider call. */
function scriptedLoop(
  h: ReturnType<typeof groundingHarness>,
  responses: ChatMessage[],
): AgentLoop {
  let callIndex = 0;
  const provider: ChatProvider = {
    async complete(request) {
      h.requests.push(request);
      const message = responses[callIndex];
      callIndex += 1;
      return { message, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return new AgentLoop({
    provider,
    reader: h.reader,
    repo: h.repo,
    evidenceValidator: h.validator,
    ledger: h.ledger,
  });
}

describe("evidence grounding end-to-end", () => {
  it("rejects a fabricated CSV-export claim, then the model submits assessment 'unknown' with no stored evidence", async () => {
    const reader = createReader({
      cacheRoot: mkdtempSync(join(tmpdir(), "repocoach-cache-")),
    });
    const repo: Repository = {
      source: { kind: "local", path: fixtureRoot },
      rootDir: fixtureRoot,
      sha: "fixture",
      meta: null,
    };

    const ledger = new ToolReturnLedger();
    const store = new InMemoryEvidenceStore();
    const validator = new GroundingEvidenceValidator({
      ledger,
      store,
      sessionId: "s1",
    });

    // The model first tries to save evidence about a CSV export that does not
    // exist in the fixture. After the rejection, it falls back to an "unknown"
    // assessment with no evidence (docs/mvp-spec.md §8).
    const responses: ChatMessage[] = [
      toolMessage("call_1", "repo_save_evidence", {
        path: "src/export/csv.ts",
        startLine: 1,
        endLine: 5,
        reason: "exports tasks as CSV",
      }),
      toolMessage("call_2", "submit_decision", {
        evidence: [],
        assessment: "unknown",
        nextAction: "show_evidence",
      }),
    ];

    const requests: ChatCompletionRequest[] = [];
    let callIndex = 0;
    const provider: ChatProvider = {
      async complete(request) {
        requests.push(request);
        const message = responses[callIndex];
        callIndex += 1;
        return { message, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const loop = new AgentLoop({
      provider,
      reader,
      repo,
      evidenceValidator: validator,
      ledger,
    });
    const result = await loop.invoke({
      phase: "trace",
      featureGoal: "understand the task creation pipeline",
      turnHistory: [],
    });

    expect(result.decision.assessment).toBe("unknown");
    expect(result.decision.evidence).toEqual([]);
    expect(store.listBySession("s1")).toEqual([]);

    // The model really received the rejection before re-deciding.
    const toolResult = requests[1].messages.find((m) => m.role === "tool")?.content ?? "";
    expect(toolResult).toContain("evidence rejected");
    expect(toolResult).toContain("src/export/csv.ts");
    expect(toolResult).toContain("1-5");
  });

  it("grounds evidence read through the loop and saves it to the store", async () => {
    const reader = createReader({
      cacheRoot: mkdtempSync(join(tmpdir(), "repocoach-cache-")),
    });
    const repo: Repository = {
      source: { kind: "local", path: fixtureRoot },
      rootDir: fixtureRoot,
      sha: "fixture",
      meta: null,
    };

    const ledger = new ToolReturnLedger();
    const store = new InMemoryEvidenceStore();
    const validator = new GroundingEvidenceValidator({
      ledger,
      store,
      sessionId: "s1",
    });

    // Read a real range, then cite a sub-range of it and submit.
    const responses: ChatMessage[] = [
      toolMessage("call_1", "repo_read_file", {
        path: "src/parse/validate.ts",
        startLine: 22,
        endLine: 32,
      }),
      toolMessage("call_2", "repo_save_evidence", {
        path: "src/parse/validate.ts",
        startLine: 24,
        endLine: 32,
        reason: "validate",
      }),
      toolMessage("call_3", "submit_decision", {
        evidence: [],
        assessment: "unknown",
        nextAction: "show_evidence",
      }),
    ];

    let callIndex = 0;
    const provider: ChatProvider = {
      async complete() {
        const message = responses[callIndex];
        callIndex += 1;
        return { message, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const loop = new AgentLoop({
      provider,
      reader,
      repo,
      evidenceValidator: validator,
      ledger,
    });
    await loop.invoke({
      phase: "trace",
      featureGoal: "understand the task creation pipeline",
      turnHistory: [],
    });

    expect(store.listBySession("s1")).toEqual([
      {
        sessionId: "s1",
        turnIndex: 0,
        evidence: {
          path: "src/parse/validate.ts",
          startLine: 24,
          endLine: 32,
          reason: "validate",
        },
      },
    ]);
  });

  it("rejects fabricated evidence in submit_decision, retries, then throws", async () => {
    const h = groundingHarness();
    const fabricated = {
      evidence: [
        { path: "src/export/csv.ts", startLine: 1, endLine: 5, reason: "exports tasks as CSV" },
      ],
      assessment: "correct",
      nextAction: "show_evidence",
    };
    const loop = scriptedLoop(h, [
      toolMessage("call_1", "submit_decision", fabricated),
      toolMessage("call_2", "submit_decision", fabricated),
      toolMessage("call_3", "submit_decision", fabricated),
    ]);

    await expect(
      loop.invoke({ phase: "trace", featureGoal: "g", turnHistory: [] }),
    ).rejects.toThrow(AgentDecisionInvalidError);

    // The model never read anything, so it got the corrective error twice.
    expect(h.requests).toHaveLength(3);
    const feedback = h.requests[1].messages.find((m) => m.role === "tool");
    expect(feedback?.content).toContain("src/export/csv.ts");
    expect(feedback?.content).toContain("1-5");
    expect(feedback?.content).toMatch(/read.*first/i);
    expect(h.store.listBySession("s1")).toEqual([]);
  });

  it("accepts evidence cited directly in submit_decision after a read", async () => {
    const h = groundingHarness();
    const loop = scriptedLoop(h, [
      toolMessage("call_1", "repo_read_file", {
        path: "src/parse/validate.ts",
        startLine: 22,
        endLine: 32,
      }),
      toolMessage("call_2", "submit_decision", {
        evidence: [{ path: "src/parse/validate.ts", startLine: 24, endLine: 32, reason: "validate" }],
        assessment: "correct",
        nextAction: "show_evidence",
      }),
    ]);

    const result = await loop.invoke({ phase: "trace", featureGoal: "g", turnHistory: [] });

    expect(result.decision.evidence).toEqual([
      { path: "src/parse/validate.ts", startLine: 24, endLine: 32, reason: "validate" },
    ]);
    expect(h.store.listBySession("s1")).toEqual([
      {
        sessionId: "s1",
        turnIndex: 0,
        evidence: { path: "src/parse/validate.ts", startLine: 24, endLine: 32, reason: "validate" },
      },
    ]);
  });

  it("re-accepts evidence already saved via repo_save_evidence without duplicating it", async () => {
    const h = groundingHarness();
    const evidence = { path: "src/parse/validate.ts", startLine: 24, endLine: 32, reason: "validate" };
    const loop = scriptedLoop(h, [
      toolMessage("call_1", "repo_read_file", {
        path: "src/parse/validate.ts",
        startLine: 22,
        endLine: 32,
      }),
      toolMessage("call_2", "repo_save_evidence", evidence),
      toolMessage("call_3", "submit_decision", {
        evidence: [evidence],
        assessment: "correct",
        nextAction: "show_evidence",
      }),
    ]);

    const result = await loop.invoke({ phase: "trace", featureGoal: "g", turnHistory: [] });

    expect(result.decision.evidence).toEqual([evidence]);
    // The same claim validated twice (repo_save_evidence + submit_decision)
    // yields a single recap record, not a duplicate.
    expect(h.store.listBySession("s1")).toEqual([
      { sessionId: "s1", turnIndex: 0, evidence },
    ]);
  });
});
