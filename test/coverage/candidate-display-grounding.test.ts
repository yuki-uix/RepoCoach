/**
 * Enumerated coverage: every candidate display field is grounded, not just the
 * one that happens to carry the riskiest wording.
 *
 * The defect this guards against is the "gate covers one field but not the
 * others" failure (issue #31: the grounding gate covered `description` but
 * missed `title`; the render layer covered `evidence.reason` but missed `path`).
 * The enumeration here is NOT a hand-written `["title", "description"]` — it is
 * derived from `featureCandidateSchema.shape` with the exact predicate
 * `candidateDisplayText` uses (string fields, excluding the machine-only `id`).
 * A new display field added to the schema is therefore exercised automatically,
 * and if `candidateDisplayText` ever stopped including a string field this suite
 * still tests it and fails the "must be grounded" assertion.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelCandidateGenerator } from "../../src/candidates/model";
import { featureCandidateSchema, type FeatureCandidate } from "../../src/domain";
import { buildRepositoryImport } from "../../src/import";
import { createReader, type Reader, type Repository } from "../../src/reader";
import type { ChatCompletionRequest, ChatProvider } from "../../src/agent";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The display fields, derived from the schema with the same predicate as
 * `candidateDisplayText`: every `z.ZodString` field except `id` (a machine
 * slug the learner never reads, not prose that names a step in the chain).
 */
const DISPLAY_FIELDS = Object.entries(featureCandidateSchema.shape)
  .filter(([field, type]) => field !== "id" && type instanceof z.ZodString)
  .map(([field]) => field);

/** A repo whose entry barrel re-exports five distinct real symbols. */
const BARREL_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "barrel", version: "0.1.0", main: "src/index.ts" }),
  "src/index.ts": 'export * from "./a.js";\n',
  "src/a.ts": "export function alpha(): number { return 1; }\n",
};

/** A fabricated, code-shaped symbol no file in the repo defines. */
const FABRICATED = "inventedSymbolXyz";

/**
 * A candidate whose only display field carrying `FABRICATED` is `field`. The
 * other display fields are symbol-free prose so the drop, when it happens, is
 * attributable to this field alone.
 */
function candidateWithFabricationIn(field: string): FeatureCandidate {
  const title = field === "title" ? `Trace ${FABRICATED}` : "Understand the entry point";
  const description =
    field === "description"
      ? `Follow ${FABRICATED} as it runs.`
      : "Understand how the entry point wires the pipeline together.";
  return {
    id: "bad",
    title,
    description,
    entryFiles: ["src/index.ts"],
    difficulty: "intro",
  };
}

/** Replay one candidate-JSON response and record every request, then fall back. */
function recordingProvider(contents: string[]): {
  provider: ChatProvider;
  requests: ChatCompletionRequest[];
} {
  const requests: ChatCompletionRequest[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      async complete(request) {
        requests.push(request);
        const content = contents[Math.min(index, contents.length - 1)];
        index += 1;
        return { message: { role: "assistant", content }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  };
}

async function generate(candidates: FeatureCandidate[]): Promise<{
  requests: ChatCompletionRequest[];
  candidates: FeatureCandidate[];
}> {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-coverage-"));
  tempDirs.push(cacheRoot);
  const reader: Reader = createReader({ cacheRoot });
  const dir = mkdtempSync(join(tmpdir(), "repocoach-coverage-repo-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(BARREL_FILES)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  const repo: Repository = await reader.importRepository(dir);
  const imp = buildRepositoryImport(reader, repo);

  const { provider, requests } = recordingProvider([JSON.stringify(candidates)]);
  const generator = new ModelCandidateGenerator({ provider });
  const kept = await generator.generate({
    reader,
    repo,
    tree: imp.tree,
    entryCandidates: imp.entryCandidates,
    packageInfo: imp.packageInfo,
  });
  return { requests, candidates: kept };
}

describe("candidate display field grounding (enumerated from featureCandidateSchema)", () => {
  it("derives its enumeration from the schema, matching candidateDisplayText's predicate", () => {
    // Locks the derivation to the schema: title + description are the display
    // fields today, `id`/`entryFiles`/`difficulty` are excluded by construction.
    expect(DISPLAY_FIELDS).toEqual(["title", "description"]);
  });

  it.each(DISPLAY_FIELDS)(
    "drops a candidate whose only fabricated symbol sits in `%s`",
    async (field) => {
      const { requests, candidates } = await generate([candidateWithFabricationIn(field)]);

      // The fabricated candidate is dropped, so generation retries once and
      // falls back to the heuristic — the bad id never reaches the learner.
      expect(requests).toHaveLength(2);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((candidate) => candidate.id !== "bad")).toBe(true);
    },
  );
});
