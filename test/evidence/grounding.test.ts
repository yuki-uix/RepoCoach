import { describe, expect, it } from "vitest";
import {
  GroundingEvidenceValidator,
  InMemoryEvidenceStore,
  ToolReturnLedger,
} from "../../src/evidence";
import type { Evidence } from "../../src/domain";

function claim(path: string, startLine: number, endLine: number): Evidence {
  return { path, startLine, endLine, reason: "test" };
}

describe("GroundingEvidenceValidator", () => {
  it("rejects an ungrounded claim with a corrective message naming path and range", () => {
    const ledger = new ToolReturnLedger();
    const store = new InMemoryEvidenceStore();
    const validator = new GroundingEvidenceValidator({
      ledger,
      store,
      sessionId: "s1",
    });

    const verdict = validator.validate(claim("src/export/csv.ts", 3, 7));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("src/export/csv.ts");
      expect(verdict.reason).toContain("3-7");
      expect(verdict.reason).toContain("repo_read_file");
      expect(verdict.reason).toContain("repo_search");
      // The corrective "read it first" hint.
      expect(verdict.reason).toMatch(/read.*first/i);
    }
  });

  // The compression window (issue #36) revokes a round's ranges once its tool
  // results leave the context. An accepted claim must survive that, or the
  // model's own saved evidence is rejected when it repeats it in
  // submit_decision — turning a cost optimisation into a failed turn.
  it("keeps an accepted claim citable after its round is revoked", () => {
    const ledger = new ToolReturnLedger();
    ledger.setRound(0);
    ledger.record("src/index.ts", 10, 20);
    const validator = new GroundingEvidenceValidator({
      ledger,
      store: new InMemoryEvidenceStore(),
      sessionId: "s1",
    });

    expect(validator.validate(claim("src/index.ts", 12, 15)).ok).toBe(true);
    ledger.revokeRound(0);

    // Re-cited at submit_decision, after compression dropped round 0.
    expect(validator.validate(claim("src/index.ts", 12, 15)).ok).toBe(true);
    // A range that was never accepted is still gone.
    expect(validator.validate(claim("src/index.ts", 10, 20)).ok).toBe(false);
  });

  it("saves a grounded claim to the store with the current turn", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src/index.ts", 10, 20);
    const store = new InMemoryEvidenceStore();
    const validator = new GroundingEvidenceValidator({
      ledger,
      store,
      sessionId: "s1",
    });
    validator.setTurnIndex(2);

    const verdict = validator.validate(claim("src/index.ts", 12, 15));

    expect(verdict).toEqual({ ok: true });
    expect(store.listBySession("s1")).toEqual([
      {
        sessionId: "s1",
        turnIndex: 2,
        evidence: { path: "src/index.ts", startLine: 12, endLine: 15, reason: "test" },
      },
    ]);
  });

  it("does not save a rejected claim", () => {
    const ledger = new ToolReturnLedger();
    const store = new InMemoryEvidenceStore();
    const validator = new GroundingEvidenceValidator({
      ledger,
      store,
      sessionId: "s1",
    });

    validator.validate(claim("src/ghost.ts", 1, 2));

    expect(store.listBySession("s1")).toEqual([]);
  });
});
