/**
 * Coverage probe for the #29 batch-evidence path: grounding must be applied per
 * item, never relaxed by batching.
 *
 * `repo_save_evidence` accepts `items: Evidence[]` in one call. The gate being
 * probed here is that each item passes the constructive-grounding validator
 * individually — a batch mixing grounded and ungrounded claims must save exactly
 * the grounded ones and reject (without saving) the rest. This is the same
 * "one gate, many items" shape the rest of this suite guards: batching is a
 * convenience, not a shortcut past grounding.
 */

import { describe, expect, it } from "vitest";
import { createToolRegistry, type Evidence } from "../../src/agent";
import {
  GroundingEvidenceValidator,
  InMemoryEvidenceStore,
  ToolReturnLedger,
} from "../../src/evidence";
import { makeTempReader } from "../agent/helpers";

const FILES = {
  "src/index.ts": "export function add(): number {\n  return 1;\n}\n",
  "src/util.ts": "export const x = 1;\n",
};

describe("batch evidence per-item grounding (#29)", () => {
  it("saves only the grounded items and rejects the rest, item by item", async () => {
    const { reader, repo } = makeTempReader(FILES);
    const ledger = new ToolReturnLedger();
    // Only src/index.ts lines 1-3 were returned by a read tool this turn.
    ledger.record("src/index.ts", 1, 3);
    const store = new InMemoryEvidenceStore();
    const validator = new GroundingEvidenceValidator({ ledger, store, sessionId: "s1" });
    const registry = createToolRegistry({ reader, repo, evidenceValidator: validator });

    const collected: Evidence[] = [];
    const result = await registry.execute({
      name: "repo_save_evidence",
      args: {
        items: [
          { path: "src/index.ts", startLine: 1, endLine: 3, reason: "grounded" },
          { path: "src/util.ts", startLine: 1, endLine: 1, reason: "never read" },
        ],
      },
      collectedEvidence: collected,
    });

    // The receipt reports the split honestly, and only the grounded item is
    // appended to the turn's list and persisted — the ungrounded one is neither
    // silently dropped nor saved.
    expect(result).toContain("Saved evidence: 1 accepted, 1 rejected.");
    expect(result).toContain("accepted src/index.ts");
    expect(result).toContain("rejected src/util.ts");
    expect(collected).toEqual([
      { path: "src/index.ts", startLine: 1, endLine: 3, reason: "grounded" },
    ]);
    expect(store.listBySession("s1")).toEqual([
      {
        sessionId: "s1",
        turnIndex: 0,
        evidence: { path: "src/index.ts", startLine: 1, endLine: 3, reason: "grounded" },
      },
    ]);
  });
});
