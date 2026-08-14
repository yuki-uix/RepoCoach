import { describe, expect, it } from "vitest";
import {
  describeJsonSyntaxError,
  parseJsonLenient,
  repairJson,
  unwrapToolArguments,
} from "../../src/agent";

describe("parseJsonLenient", () => {
  it("accepts valid JSON without repairing", () => {
    const result = parseJsonLenient('{"evidence": [], "nextAction": "finish"}');
    expect(result).toEqual({
      ok: true,
      value: { evidence: [], nextAction: "finish" },
    });
  });

  it("repairs an invalid escape and parses the literal", () => {
    // The wire text carries a single backslash before 'd' (an invalid escape).
    const raw = '{"reason": "the regex is \\d+"}';
    expect(() => JSON.parse(raw)).toThrow();

    const result = parseJsonLenient(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { reason: string }).reason).toBe("the regex is \\d+");
    }
  });

  it("repairs a backslash-space into a literal", () => {
    const result = parseJsonLenient('{"reason": "a\\ b"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { reason: string }).reason).toBe("a\\ b");
    }
  });

  it("repairs a raw newline inside a string", () => {
    const raw = '{"reason": "line1\nline2"}';
    const result = parseJsonLenient(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { reason: string }).reason).toBe("line1\nline2");
    }
  });

  it("strips trailing commas in objects and arrays", () => {
    const result = parseJsonLenient('{"a": [1, 2,], "b": {"c": 3,},}');
    expect(result).toEqual({ ok: true, value: { a: [1, 2], b: { c: 3 } } });
  });

  it("rejects structurally broken input with a targeted syntax error", () => {
    const result = parseJsonLenient('{"reason": "unterminated');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("syntax");
    }
  });
});

describe("repairJson", () => {
  it("returns null for an unterminated string", () => {
    expect(repairJson('{"a": "oops')).toBeNull();
  });

  it("returns null for a trailing lone backslash", () => {
    expect(repairJson('{"a": "oops\\')).toBeNull();
  });
});

describe("unwrapToolArguments", () => {
  it("unwraps a single 'arguments' wrapper key", () => {
    expect(unwrapToolArguments({ arguments: { evidence: [], nextAction: "finish" } })).toEqual({
      evidence: [],
      nextAction: "finish",
    });
  });

  it("unwraps 'input' and 'parameters' wrapper keys", () => {
    expect(unwrapToolArguments({ input: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapToolArguments({ parameters: { a: 1 } })).toEqual({ a: 1 });
  });

  it("does not unwrap a non-object wrapper value", () => {
    expect(unwrapToolArguments({ arguments: "nope" })).toEqual({ arguments: "nope" });
  });

  it("does not unwrap a multi-key object", () => {
    expect(unwrapToolArguments({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("does not unwrap a non-object", () => {
    expect(unwrapToolArguments([1, 2])).toEqual([1, 2]);
    expect(unwrapToolArguments("x")).toBe("x");
  });
});

describe("describeJsonSyntaxError", () => {
  it("surfaces the position from a SyntaxError message", () => {
    expect(describeJsonSyntaxError(new Error("Bad escaped character in JSON at position 10"))).toContain(
      "position 10",
    );
  });

  it("falls back to the raw message without a position", () => {
    expect(describeJsonSyntaxError(new Error("boom"))).toBe("invalid JSON (boom)");
  });
});
