import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  benchmarksFileSchema,
  loadBenchmarks,
  type Benchmark,
} from "../../src/eval/benchmarks.js";

const PINNED_SHA = "0123456789abcdef0123456789abcdef01234567";

function validBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    name: "zod",
    repositoryId: `https://github.com/colinhacks/zod#${PINNED_SHA}`,
    featureId: "schema-parse",
    featureGoal: "Trace how a Zod schema validates a value.",
    entryFiles: ["src/types.ts"],
    answers: ["It runs _parse and throws ZodError."],
    ...overrides,
  };
}

/** The project root, so the committed benchmarks file itself is validated. */
function repoRootOfProject(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a temp repoRoot with a benchmarks file at the expected path. */
function writeBenchmarksFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-benchmarks-"));
  tempDirs.push(dir);
  const benchmarksDir = join(dir, "fixtures", "benchmarks");
  mkdirSync(benchmarksDir, { recursive: true });
  writeFileSync(
    join(benchmarksDir, "real-repos.json"),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
  return dir;
}

describe("benchmarksFileSchema", () => {
  it("parses a valid benchmark file", () => {
    const parsed = benchmarksFileSchema.parse([validBenchmark()]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.featureId).toBe("schema-parse");
  });

  // The all-zero SHA passes the 40-hex check while pinning no commit — the
  // shape a placeholder takes while a benchmark is being drafted. It shipped
  // that way once, so it is rejected explicitly rather than by eyeballing.
  it("rejects the all-zero placeholder SHA", () => {
    const result = benchmarksFileSchema.safeParse([
      validBenchmark({
        repositoryId: `https://github.com/colinhacks/zod#${"0".repeat(40)}`,
      }),
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(" ")).toContain(
        "all-zero placeholder SHA",
      );
    }
  });

  // And the real shipped file must itself be valid — the guard above is
  // worthless if nothing checks the file it was written for.
  it("the committed real-repos.json passes validation", () => {
    expect(() => loadBenchmarks(repoRootOfProject())).not.toThrow();
  });

  it("rejects a remote repositoryId without a pinned commit SHA", () => {
    const result = benchmarksFileSchema.safeParse([
      validBenchmark({ repositoryId: "https://github.com/colinhacks/zod" }),
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(" ")).toContain(
        "must pin a full 40-char commit SHA",
      );
    }
  });

  it("rejects a partial SHA (not a full 40-hex commit)", () => {
    const result = benchmarksFileSchema.safeParse([
      validBenchmark({ repositoryId: "https://github.com/colinhacks/zod#abcdef123" }),
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate benchmark names", () => {
    const result = benchmarksFileSchema.safeParse([
      validBenchmark(),
      validBenchmark({ featureGoal: "A different feature." }),
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(" ")).toContain(
        "duplicate benchmark name",
      );
    }
  });

  it("rejects an empty answers array and an empty entryFiles array", () => {
    expect(benchmarksFileSchema.safeParse([validBenchmark({ answers: [] })]).success).toBe(false);
    expect(
      benchmarksFileSchema.safeParse([validBenchmark({ entryFiles: [] })]).success,
    ).toBe(false);
  });

  it("rejects an empty file (no benchmarks)", () => {
    expect(benchmarksFileSchema.safeParse([]).success).toBe(false);
  });
});

describe("loadBenchmarks", () => {
  it("loads every benchmark when no name is given", () => {
    const root = writeBenchmarksFile([validBenchmark(), validBenchmark({ name: "hono" })]);
    expect(loadBenchmarks(root).map((benchmark) => benchmark.name)).toEqual(["zod", "hono"]);
  });

  it("selects a single benchmark by name", () => {
    const root = writeBenchmarksFile([validBenchmark(), validBenchmark({ name: "hono" })]);
    expect(loadBenchmarks(root, "hono")).toHaveLength(1);
    expect(loadBenchmarks(root, "hono")[0]?.name).toBe("hono");
  });

  it("throws a clear error for an unknown benchmark name", () => {
    const root = writeBenchmarksFile([validBenchmark()]);
    expect(() => loadBenchmarks(root, "missing")).toThrow(/No benchmark named "missing"/);
  });

  it("throws a clear error for a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "repocoach-benchmarks-empty-"));
    tempDirs.push(root);
    expect(() => loadBenchmarks(root)).toThrow(/Missing benchmarks file/);
  });

  it("throws a clear error for invalid JSON", () => {
    const root = writeBenchmarksFile("{ not json");
    expect(() => loadBenchmarks(root)).toThrow(/Invalid JSON in/);
  });

  it("throws a clear error naming the offending field on a schema violation", () => {
    const root = writeBenchmarksFile([
      validBenchmark({ repositoryId: "https://github.com/colinhacks/zod" }),
    ]);
    expect(() => loadBenchmarks(root)).toThrow(/Invalid benchmarks file/);
    expect(() => loadBenchmarks(root)).toThrow(/must pin a full 40-char commit SHA/);
  });
});
