import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatProvider } from "../../src/agent";
import { assembleSession, repositoryIdWithSha, runCli, splitRepositoryId } from "../../src/cli";
import {
  createReader,
  readFileSlice,
  type FetchLike,
  type GitRunner,
  type Reader,
} from "../../src/reader";
import { JsonSessionStore, resumeSession } from "../../src/store";
import { cleanupDir, createTempRepo, runGit } from "../reader/helpers";
import { capturedStreams, fixtureRoot, makeDataDir } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupDir(dir);
  }
});

const GITHUB_URL = "https://github.com/o/n";
const GITHUB_CLONE_URL = `${GITHUB_URL}.git`;

const noMeta: FetchLike = async () => ({ ok: false, json: async () => ({}) });

/**
 * Redirect the reader's `https://github.com/o/n.git` clone URL to a local git
 * repo, so a github-source import runs a real clone/checkout against a temp
 * remote. `--filter=blob:none` only applies to HTTP remotes, so strip it the
 * same way `cloneRepo` omits it for local-path remotes.
 */
function localRemoteGit(repoDir: string): GitRunner {
  return async (args, cwd) => {
    const rewritten: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--filter=blob:none") {
        continue;
      }
      if (arg === "--filter") {
        i += 1;
        continue;
      }
      rewritten.push(arg === GITHUB_CLONE_URL ? repoDir : arg);
    }
    return runGit(rewritten, cwd);
  };
}

interface RecordedImport {
  input: string;
  ref?: string;
  sha: string;
  rootDir: string;
}

/** Wrap a real reader, recording every import's (input, ref) and resolved repo. */
function recordingReader(real: Reader): Reader & { imports: RecordedImport[] } {
  const imports: RecordedImport[] = [];
  return {
    ...real,
    imports,
    async importRepository(input, ref) {
      const repo = await real.importRepository(input, ref);
      imports.push({ input, ref, sha: repo.sha, rootDir: repo.rootDir });
      return repo;
    },
  };
}

function crashingProvider(): ChatProvider {
  return {
    async complete() {
      throw new Error("connection dropped (simulated crash)");
    },
  };
}

describe("CLI resume pins the commit SHA (P1)", () => {
  it("resumes the commit a session started from, not the moved HEAD", async () => {
    // Two commits: the second moves `a.txt` from "old" to "new".
    const repo = await createTempRepo({ "a.txt": "old\n" }, { "a.txt": "new\n" });
    tempDirs.push(repo.dir);
    const oldSha = repo.commits[0];
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const dataDir = makeDataDir();

    const reader = recordingReader(
      createReader({ cacheRoot, git: localRemoteGit(repo.dir), fetchFn: noMeta }),
    );

    // Phase 1 — start from the old SHA, then crash on the first agent call so
    // the session is left active (orientation), exactly like an interrupt.
    const streams1 = capturedStreams();
    streams1.stdin.write("1\n");
    const code1 = await runCli(["start", `${GITHUB_URL}/tree/${oldSha}`], {
      dataDir,
      reader,
      provider: crashingProvider(),
      stdin: streams1.stdin,
      stdout: streams1.stdout,
      stderr: streams1.stderr,
    });
    streams1.stdin.end();
    expect(code1).toBe(1);

    const session = new JsonSessionStore(dataDir).listSessions()[0];
    expect(session?.repositoryId).toBe(`${GITHUB_URL}#${oldSha}`);
    expect(reader.imports[0]?.sha).toBe(oldSha);

    // Phase 2 — resume: the reader must be handed the pinned SHA (not HEAD).
    const streams2 = capturedStreams();
    const code2 = await runCli(["resume", session!.id], {
      dataDir,
      reader,
      provider: crashingProvider(),
      stdin: streams2.stdin,
      stdout: streams2.stdout,
      stderr: streams2.stderr,
    });
    expect(code2).toBe(1);

    const resumedImport = reader.imports.at(-1);
    expect(resumedImport?.input).toBe(GITHUB_URL);
    expect(resumedImport?.ref).toBe(oldSha);
    // The resumed root holds the OLD content, not the second commit's.
    expect(readFileSlice(resumedImport!.rootDir, "a.txt").content).toBe("old");
  });

  it("warns and keeps current behavior when a legacy session has no SHA", async () => {
    const repo = await createTempRepo({ "a.txt": "hello\n" });
    tempDirs.push(repo.dir);
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const dataDir = makeDataDir();

    const reader = recordingReader(
      createReader({ cacheRoot, git: localRemoteGit(repo.dir), fetchFn: noMeta }),
    );
    // Legacy session: repositoryId is a bare URL with no `#sha` suffix.
    const session = new JsonSessionStore(dataDir).createSession({
      repositoryId: GITHUB_URL,
      featureId: "x",
    });

    const streams = capturedStreams();
    const code = await runCli(["resume", session.id], {
      dataDir,
      reader,
      provider: crashingProvider(),
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(code).toBe(1);

    const resumedImport = reader.imports.at(-1);
    expect(resumedImport?.input).toBe(GITHUB_URL);
    expect(resumedImport?.ref).toBeUndefined();
    expect(streams.stderrText()).toContain("no pinned commit SHA");
  });

  it("round-trips the pinned SHA through the repository id helpers", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const github = {
      source: { kind: "github" as const, owner: "o", name: "n" },
      rootDir: "/tmp/x",
      sha,
      meta: null,
    };
    expect(repositoryIdWithSha(github)).toBe(`${GITHUB_URL}#${sha}`);
    expect(splitRepositoryId(`${GITHUB_URL}#${sha}`)).toEqual({
      input: GITHUB_URL,
      sha,
    });

    // A local path with a `#` that is not a SHA survives the round-trip.
    const local = { source: { kind: "local" as const, path: "/tmp/re#po" }, rootDir: "/tmp/re#po", sha, meta: null };
    expect(splitRepositoryId(repositoryIdWithSha(local))).toEqual({
      input: "/tmp/re#po",
      sha,
    });

    // A bare id (legacy) carries no SHA.
    expect(splitRepositoryId(GITHUB_URL)).toEqual({ input: GITHUB_URL });
  });

  it("reimports a pinned id through the real reader to the exact commit", async () => {
    const repo = await createTempRepo({ "a.txt": "old\n" }, { "a.txt": "new\n" });
    tempDirs.push(repo.dir);
    const oldSha = repo.commits[0];
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const dataDir = makeDataDir();

    const reader = createReader({ cacheRoot, git: localRemoteGit(repo.dir), fetchFn: noMeta });
    const asm = assembleSession({ dataDir, reader });

    // Start from the old SHA, then store the pinned id.
    const repo1 = await asm.reader.importRepository(`${GITHUB_URL}/tree/${oldSha}`);
    const session = asm.store.createSession({
      repositoryId: repositoryIdWithSha(repo1),
      featureId: "x",
    });

    // Resume via the same id the store persisted.
    const resumed = resumeSession(asm.store, session.id);
    const { input, sha } = splitRepositoryId(resumed.session.repositoryId);
    expect(sha).toBe(oldSha);
    const repo2 = await asm.reader.importRepository(input, sha);

    expect(repo2.sha).toBe(oldSha);
    expect(readFileSlice(repo2.rootDir, "a.txt").content).toBe("old");
  });
});

describe("CLI assembly provider is lazy (P2)", () => {
  it("lists existing sessions without an API key", async () => {
    const dataDir = makeDataDir();
    const session = new JsonSessionStore(dataDir).createSession({
      repositoryId: GITHUB_URL,
      featureId: "x",
    });
    const streams = capturedStreams();

    const code = await runCli(["list"], {
      dataDir,
      envFilePath: join(dataDir, "does-not-exist.env.local"),
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    expect(streams.stdoutText()).toContain(session.id);
    expect(streams.stdoutText()).toContain(GITHUB_URL);
    expect(streams.stderrText()).toBe("");
  });

  it("start still reports a clear error without an API key", async () => {
    const dataDir = makeDataDir();
    const envFilePath = join(dataDir, "does-not-exist.env.local");
    const streams = capturedStreams();
    streams.stdin.write("1\n");

    const code = await runCli(["start", fixtureRoot], {
      dataDir,
      envFilePath,
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    streams.stdin.end();

    expect(code).toBe(1);
    expect(streams.stderrText()).toContain("Could not read env file");
    expect(streams.stderrText()).toContain(envFilePath);
  });
});
