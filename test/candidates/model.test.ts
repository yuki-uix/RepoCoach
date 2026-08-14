import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPO_DATA_END,
  REPO_DATA_START,
  type ChatCompletionRequest,
  type ChatProvider,
} from "../../src/agent";
import { ModelCandidateGenerator } from "../../src/candidates/model";
import { featureCandidateSchema } from "../../src/domain";
import { buildRepositoryImport } from "../../src/import";
import { createReader, type Reader } from "../../src/reader";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeReader(): Reader {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-model-"));
  tempDirs.push(cacheRoot);
  return createReader({ cacheRoot });
}

/** A provider that replays `contents` and records every request it received. */
function recordingProvider(
  contents: Array<string | null>,
): { provider: ChatProvider; requests: ChatCompletionRequest[] } {
  const requests: ChatCompletionRequest[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      async complete(request) {
        requests.push(request);
        const content = contents[Math.min(index, contents.length - 1)] ?? null;
        index += 1;
        return {
          message: { role: "assistant", content },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  };
}

describe("ModelCandidateGenerator", () => {
  it("retries once then falls back to the heuristic on invalid output", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const { provider, requests } = recordingProvider(["not json", "still not json"]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    // One attempt + one retry before the heuristic fallback.
    expect(requests).toHaveLength(2);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(featureCandidateSchema.safeParse(candidate).success).toBe(true);
    }
    // The heuristic fallback names a real entry file from the fixture.
    expect(candidates.some((c) => c.entryFiles.includes("src/index.ts"))).toBe(
      true,
    );
  });

  it("wraps repo data and keeps it out of the system prompt", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const valid = JSON.stringify([
      {
        id: "m1",
        title: "Model candidate",
        description: "d",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
    ]);
    const { provider, requests } = recordingProvider([valid]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("m1");
    expect(requests).toHaveLength(1);

    const messages = requests[0]!.messages;
    const system = messages.find((message) => message.role === "system");
    const user = messages.find((message) => message.role === "user");

    // Repository data never reaches the system prompt.
    expect(system?.content ?? "").not.toContain("src/index.ts");
    expect(system?.content ?? "").not.toContain("createTracker");
    // Repository data is wrapped in REPO_DATA markers in the user message.
    expect(user?.content ?? "").toContain(REPO_DATA_START);
    expect(user?.content ?? "").toContain(REPO_DATA_END);
    expect(user?.content ?? "").toContain("src/index.ts");
  });
});
