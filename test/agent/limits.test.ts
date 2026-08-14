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

  it("always keeps at least one line even when it alone exceeds the budget", () => {
    const { content, keptLines } = fitSourceLines("x".repeat(500), 10);
    expect(keptLines).toBe(1);
    expect(content).toBe("x".repeat(500));
  });
});
