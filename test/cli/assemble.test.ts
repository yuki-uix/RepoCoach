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
import { assembleSession } from "../../src/cli";
import { createReader, type Reader } from "../../src/reader";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");
const monorepoRoot = join(repoRoot, "fixtures", "fixture-monorepo");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeReader(): Reader {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-assemble-"));
  tempDirs.push(cacheRoot);
  return createReader({ cacheRoot });
}

/**
 * Assemble the real default graph — crucially WITHOUT a `candidateProvider`
 * override — so `listCandidates` exercises `defaultCandidateProvider`'s routing.
 * A mock provider is injected where the model path is under test (the provider
 * is the only model seam; the candidate provider itself stays default).
 */
function assembleDefault(provider?: ChatProvider) {
  return assembleSession({
    reader: makeReader(),
    dataDir: mkdtempSync(join(tmpdir(), "repocoach-assemble-data-")),
    repoRoot,
    provider,
  });
}

/** A provider that replays candidate-JSON `contents` and records each request. */
function candidateModelProvider(
  contents: string[],
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

describe("assembleSession default candidate routing", () => {
  it("routes fixture-repo to the pre-authored whitelist", async () => {
    const asm = assembleDefault();
    const repo = await asm.reader.importRepository(fixtureRoot);

    const candidates = await asm.candidateProvider.listCandidates(repo);

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "task-creation",
      "task-validation",
      "in-memory-storage",
    ]);
  });

  it("routes non-fixture repos through the model generator by default", async () => {
    const { provider, requests } = candidateModelProvider([
      JSON.stringify([
        {
          id: "m-core",
          title: "Model candidate",
          description: "d",
          entryFiles: ["packages/core/src/index.ts"],
          difficulty: "intro",
        },
      ]),
    ]);
    const asm = assembleDefault(provider);
    const repo = await asm.reader.importRepository(monorepoRoot);

    const candidates = await asm.candidateProvider.listCandidates(repo, {
      workspacePath: "packages/core",
    });

    // The model was actually consulted — the default non-fixture path is the
    // model generator, not the bare heuristic.
    expect(candidates.map((candidate) => candidate.id)).toEqual(["m-core"]);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const system = request.messages.find((message) => message.role === "system");
    const user = request.messages.find((message) => message.role === "user");
    // Repo data (workspace scope + tree) is data-guard-wrapped and never leaks
    // into the fixed system prompt.
    expect(system?.content ?? "").not.toContain("packages/core/src/index.ts");
    expect(user?.content ?? "").toContain(REPO_DATA_START);
    expect(user?.content ?? "").toContain(REPO_DATA_END);
    expect(user?.content ?? "").toContain("Workspace scope: packages/core");
    // Workspace scoping is honoured — never the whole repo, and never the
    // fixture-repo whitelist (whose entries live under `src/`).
    for (const candidate of candidates) {
      for (const path of candidate.entryFiles) {
        expect(path.startsWith("packages/core/")).toBe(true);
      }
    }
  });

  it("falls back to the heuristic when the model returns invalid output", async () => {
    const { provider, requests } = candidateModelProvider(["not json", "still not json"]);
    const asm = assembleDefault(provider);
    const repo = await asm.reader.importRepository(monorepoRoot);

    const candidates = await asm.candidateProvider.listCandidates(repo, {
      workspacePath: "packages/core",
    });

    // One attempt + one retry, then the deterministic heuristic still yields
    // real, workspace-scoped candidates.
    expect(requests).toHaveLength(2);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      for (const path of candidate.entryFiles) {
        expect(path.startsWith("packages/core/")).toBe(true);
      }
    }
  });
});
