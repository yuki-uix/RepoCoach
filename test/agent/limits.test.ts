import { describe, expect, it } from "vitest";
import { byteLength, fitSourceLines, truncateBytes } from "../../src/agent";

describe("truncateBytes", () => {
  it("returns text unchanged when under the limit", () => {
    expect(truncateBytes("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates at the byte budget without splitting a multibyte char", () => {
    const text = "你好世界";
    const { text: cut, truncated } = truncateBytes(text, byteLength("你好") + 1);
    expect(truncated).toBe(true);
    expect(byteLength(cut)).toBeLessThanOrEqual(byteLength("你好") + 1);
    expect(cut).toBe("你好");
  });
});

describe("fitSourceLines", () => {
  it("keeps the first whole line when only one fits", () => {
    const { content, keptLines, truncated } = fitSourceLines("aaaa\nbbbb\ncccc", 20);
    expect(content).toBe("aaaa");
    expect(keptLines).toBe(1);
    expect(truncated).toBe(true);
  });

  it("keeps every line when the content fits", () => {
    const { content, keptLines, truncated } = fitSourceLines("a\nb\nc", 10_000);
    expect(content).toBe("a\nb\nc");
    expect(keptLines).toBe(3);
    expect(truncated).toBe(false);
  });

  it("byte-truncates a first line that alone exceeds the budget and marks it truncated", () => {
    const { content, keptLines, truncated } = fitSourceLines("x".repeat(500), 10);
    expect(truncated).toBe(true);
    // Only the prefix is reserved, so the shown line is the first 3 bytes; no
    // line is fully shown, hence nothing is citable (keptLines === 0).
    expect(keptLines).toBe(0);
    expect(content).toBe("xxx");
  });

  it("accounts for the exact numbering prefix, not a rough per-line estimate", () => {
    // startLine beyond 4 digits widens the prefix to 5+ digits; the exact
    // accounting must still never exceed the budget.
    const content = "a\nb\nc";
    const { content: kept, keptLines } = fitSourceLines(content, 20, 12_345);
    // The 5-digit prefix is 8 bytes, so each line costs 9 bytes: "12345 | a" and
    // "12346 | b" total 9 + 1 + 9 = 19 bytes; "12347 | c" would push it to 29.
    expect(keptLines).toBe(2);
    expect(kept).toBe("a\nb");
  });
});
