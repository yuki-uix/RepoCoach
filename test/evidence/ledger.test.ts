import { describe, expect, it } from "vitest";
import { ToolReturnLedger } from "../../src/evidence";
import type { Evidence } from "../../src/domain";

function claim(path: string, startLine: number, endLine: number): Evidence {
  return { path, startLine, endLine, reason: "test" };
}

describe("ToolReturnLedger", () => {
  it("grounds a claim fully contained in a recorded range", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src/index.ts", 10, 20);
    expect(ledger.isGrounded(claim("src/index.ts", 12, 15))).toBe(true);
  });

  it("rejects a claim whose range is legal but was never read", () => {
    const ledger = new ToolReturnLedger();
    expect(ledger.isGrounded(claim("src/index.ts", 1, 5))).toBe(false);
  });

  it("rejects a claim that partially exceeds a recorded range", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src/index.ts", 10, 20);
    expect(ledger.isGrounded(claim("src/index.ts", 8, 15))).toBe(false);
  });

  it("rejects a claim stitched across two adjacent records", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src/index.ts", 5, 10);
    ledger.record("src/index.ts", 11, 20);
    expect(ledger.isGrounded(claim("src/index.ts", 8, 12))).toBe(false);
  });

  it("rejects a claim on an unrecorded path", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src/a.ts", 1, 10);
    expect(ledger.isGrounded(claim("src/b.ts", 2, 3))).toBe(false);
  });

  it("compares backslash and forward-slash paths as equal", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src\\index.ts", 1, 10);
    expect(ledger.isGrounded(claim("src/index.ts", 2, 3))).toBe(true);
  });

  it("forgets all records after resetTurn", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src/index.ts", 1, 10);
    expect(ledger.isGrounded(claim("src/index.ts", 2, 3))).toBe(true);

    ledger.resetTurn();

    expect(ledger.isGrounded(claim("src/index.ts", 2, 3))).toBe(false);
  });
});

describe("ToolReturnLedger carried ranges", () => {
  it("grounds a claim contained in a carried range without a tool return", () => {
    const ledger = new ToolReturnLedger();
    ledger.recordCarried("src/index.ts", 1, 50);
    expect(ledger.isGrounded(claim("src/index.ts", 10, 20))).toBe(true);
  });

  it("rejects a claim partially outside a carried range", () => {
    const ledger = new ToolReturnLedger();
    ledger.recordCarried("src/index.ts", 10, 20);
    expect(ledger.isGrounded(claim("src/index.ts", 8, 15))).toBe(false);
  });

  it("grounds via either a tool return or a carried range (union)", () => {
    const ledger = new ToolReturnLedger();
    ledger.record("src/a.ts", 1, 10);
    ledger.recordCarried("src/b.ts", 1, 10);
    expect(ledger.isGrounded(claim("src/a.ts", 2, 3))).toBe(true);
    expect(ledger.isGrounded(claim("src/b.ts", 2, 3))).toBe(true);
  });

  it("hasCarried is exact-match and independent of hasRead", () => {
    const ledger = new ToolReturnLedger();
    ledger.recordCarried("src/a.ts", 1, 10);
    expect(ledger.hasCarried("src/a.ts", 1, 10)).toBe(true);
    expect(ledger.hasCarried("src/a.ts", 2, 9)).toBe(false);
    expect(ledger.hasRead("src/a.ts", 1, 10)).toBe(false);
  });

  it("clears carried ranges on resetTurn", () => {
    const ledger = new ToolReturnLedger();
    ledger.recordCarried("src/index.ts", 1, 10);
    expect(ledger.isGrounded(claim("src/index.ts", 2, 3))).toBe(true);

    ledger.resetTurn();

    expect(ledger.isGrounded(claim("src/index.ts", 2, 3))).toBe(false);
    expect(ledger.hasCarried("src/index.ts", 1, 10)).toBe(false);
  });
});

describe("ToolReturnLedger round revocation", () => {
  it("revokes only the ranges recorded in the given round", () => {
    const ledger = new ToolReturnLedger();
    ledger.setRound(0);
    ledger.record("src/index.ts", 1, 10);
    ledger.record("src/index.ts", 20, 30);
    ledger.setRound(1);
    ledger.record("src/index.ts", 40, 50);

    ledger.revokeRound(0);

    expect(ledger.isGrounded(claim("src/index.ts", 1, 5))).toBe(false);
    expect(ledger.isGrounded(claim("src/index.ts", 20, 25))).toBe(false);
    expect(ledger.isGrounded(claim("src/index.ts", 40, 45))).toBe(true);
  });

  it("leaves a re-read sub-range on the same path citable (revocation is per round, not per path)", () => {
    const ledger = new ToolReturnLedger();
    ledger.setRound(0);
    ledger.record("src/index.ts", 1, 10);
    ledger.setRound(1);
    ledger.record("src/index.ts", 1, 3); // re-read a sub-range in a live round

    ledger.revokeRound(0);

    // The round-1 sub-range survives, but the round-0 tail does not.
    expect(ledger.isGrounded(claim("src/index.ts", 1, 3))).toBe(true);
    expect(ledger.isGrounded(claim("src/index.ts", 4, 10))).toBe(false);
  });

  it("never revokes carried ranges", () => {
    const ledger = new ToolReturnLedger();
    ledger.recordCarried("src/a.ts", 1, 50);
    ledger.setRound(0);
    ledger.record("src/b.ts", 1, 5);

    ledger.revokeRound(0);

    expect(ledger.isGrounded(claim("src/a.ts", 10, 20))).toBe(true);
    expect(ledger.isGrounded(claim("src/b.ts", 1, 5))).toBe(false);
  });

  // Without this, compression would revoke ranges the model had already saved
  // as accepted evidence, and submit_decision would reject the model's own
  // evidence — failing the turn instead of just costing fewer tokens.
  it("keeps an already-validated range citable after its round is revoked", () => {
    const ledger = new ToolReturnLedger();
    ledger.setRound(0);
    ledger.record("src/index.ts", 1, 10);
    ledger.recordValidated("src/index.ts", 2, 4); // saved while still visible

    ledger.revokeRound(0);

    expect(ledger.isGrounded(claim("src/index.ts", 2, 4))).toBe(true);
    // Only what was actually saved survives; the rest of the round is gone.
    expect(ledger.isGrounded(claim("src/index.ts", 1, 10))).toBe(false);
    // And it does not masquerade as content still present in the context, so a
    // re-read is not suppressed.
    expect(ledger.hasCarried("src/index.ts", 2, 4)).toBe(false);
  });

  it("resetTurn clears the round association for the next turn", () => {
    const ledger = new ToolReturnLedger();
    ledger.setRound(3);
    ledger.record("src/index.ts", 1, 10);

    ledger.resetTurn();
    ledger.setRound(0);
    ledger.record("src/index.ts", 5, 6);

    expect(ledger.isGrounded(claim("src/index.ts", 1, 2))).toBe(false);
    expect(ledger.isGrounded(claim("src/index.ts", 5, 6))).toBe(true);
  });
});
