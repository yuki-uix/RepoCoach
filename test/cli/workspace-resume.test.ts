import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatProvider } from "../../src/agent";
import {
  GeneratedCandidateProvider,
  runCli,
  type CandidateScope,
} from "../../src/cli";
import type { FeatureCandidate } from "../../src/domain";
import { createReader, type Reader, type Repository } from "../../src/reader";
import { JsonSessionStore } from "../../src/store";
import { capturedStreams, makeDataDir } from "./helpers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const monorepoRoot = join(repoRoot, "fixtures", "fixture-monorepo");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function crashingProvider(): ChatProvider {
  return {
    async complete() {
      throw new Error("connection dropped (simulated crash)");
    },
  };
}

interface RecordedCall {
  scope?: CandidateScope;
  candidates: FeatureCandidate[];
}

/** Wrap the real generator, recording every (scope, candidates) it produces. */
function recordingProvider(reader: Reader) {
  const inner = new GeneratedCandidateProvider(reader);
  const calls: RecordedCall[] = [];
  return {
    provider: {
      async listCandidates(
        repo: Repository,
        scope?: CandidateScope,
      ): Promise<FeatureCandidate[]> {
        const candidates = await inner.listCandidates(repo, scope);
        calls.push({ scope, candidates });
        return candidates;
      },
    },
    calls,
  };
}

describe("CLI resume re-scopes to the persisted workspace (P1)", () => {
  it("resumes the same packages/core candidates it started with", async () => {
    const dataDir = makeDataDir();
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const reader = createReader({ cacheRoot });

    // Phase 1 — start over the monorepo, pick workspace 2 (packages/core) and
    // its first candidate, then crash on the first agent call so the session
    // stays active, exactly like an interrupt.
    const rec1 = recordingProvider(reader);
    const streams1 = capturedStreams();
    streams1.stdin.write("2\n1\n");
    const code1 = await runCli(["start", monorepoRoot], {
      dataDir,
      reader,
      candidateProvider: rec1.provider,
      provider: crashingProvider(),
      stdin: streams1.stdin,
      stdout: streams1.stdout,
      stderr: streams1.stderr,
    });
    streams1.stdin.end();
    expect(code1).toBe(1);

    const session = new JsonSessionStore(dataDir).listSessions()[0];
    expect(session?.workspacePath).toBe("packages/core");

    // Phase 2 — resume: the candidate list must be re-scoped to packages/core,
    // not widened to the whole repository.
    const rec2 = recordingProvider(reader);
    const streams2 = capturedStreams();
    const code2 = await runCli(["resume", session!.id], {
      dataDir,
      reader,
      candidateProvider: rec2.provider,
      provider: crashingProvider(),
      stdin: streams2.stdin,
      stdout: streams2.stdout,
      stderr: streams2.stderr,
    });
    expect(code2).toBe(1);

    const first = rec1.calls[0];
    const resumed = rec2.calls[0];
    expect(first?.scope?.workspacePath).toBe("packages/core");
    expect(resumed?.scope?.workspacePath).toBe("packages/core");
    expect(resumed?.candidates.map((candidate) => candidate.id)).toEqual(
      first?.candidates.map((candidate) => candidate.id),
    );

    for (const candidate of resumed?.candidates ?? []) {
      for (const path of candidate.entryFiles) {
        expect(path.startsWith("packages/core/")).toBe(true);
      }
    }
    // No candidate may leak in from another workspace.
    expect(
      (resumed?.candidates ?? []).some((candidate) =>
        candidate.entryFiles.some((path) => path.startsWith("packages/cli/")),
      ),
    ).toBe(false);
  });
});
