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
