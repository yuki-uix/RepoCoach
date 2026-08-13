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
