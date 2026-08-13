import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatProvider } from "../../src/agent";
import { repositoryIdWithSha, runCli } from "../../src/cli";
import { createReader, readFileSlice, type Reader } from "../../src/reader";
import { JsonSessionStore } from "../../src/store";
import { cleanupDir, createTempRepo, runGit, writeFiles } from "../reader/helpers";
import { capturedStreams, makeDataDir } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupDir(dir);
  }
});

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

describe("CLI resume pins a local git-root path to its SHA (P1)", () => {
  it("resumes the commit a local git-root session started from, not the moved HEAD", async () => {
    // Start from one commit, then append a second that overwrites a.txt.
    const repo = await createTempRepo({ "a.txt": "old\n" });
    tempDirs.push(repo.dir);
    const oldSha = repo.sha;
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const dataDir = makeDataDir();

    const reader = recordingReader(createReader({ cacheRoot }));

    // Phase 1 — start from the local git root, then crash on the first agent
    // call so the session stays active (orientation), like an interrupt.
    const streams1 = capturedStreams();
    streams1.stdin.write("1\n");
    const code1 = await runCli(["start", repo.dir], {
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
    expect(session?.repositoryId).toBe(`${repo.dir}#${oldSha}`);

    // Move HEAD forward: the second commit overwrites a.txt.
    writeFiles(repo.dir, { "a.txt": "new\n" });
    await runGit(["add", "-A"], repo.dir);
    await runGit(["commit", "-q", "-m", "second"], repo.dir);

    // Phase 2 — resume: the reader must be handed the pinned SHA, and the
    // local clone must check out the OLD content, not the moved HEAD.
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
    expect(resumedImport?.input).toBe(repo.dir);
    expect(resumedImport?.ref).toBe(oldSha);
    expect(readFileSlice(resumedImport!.rootDir, "a.txt").content).toBe("old");
  });

  it("resumes the pinned SHA when the working tree was later dirtied without a commit", async () => {
    const repo = await createTempRepo({ "a.txt": "old\n" });
    tempDirs.push(repo.dir);
    const oldSha = repo.sha;
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const dataDir = makeDataDir();

    const reader = recordingReader(createReader({ cacheRoot }));

    // Phase 1 — start from the clean local git root, then crash on the first
    // agent call so the session stays active (orientation), like an interrupt.
    const streams1 = capturedStreams();
    streams1.stdin.write("1\n");
    const code1 = await runCli(["start", repo.dir], {
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
    expect(session?.repositoryId).toBe(`${repo.dir}#${oldSha}`);

    // Dirty the working tree WITHOUT committing. The recorded SHA must still be
    // honoured on resume — analysing the modified working tree would silently
    // read the wrong version.
    writeFiles(repo.dir, { "a.txt": "uncommitted\n" });

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
    expect(resumedImport?.input).toBe(repo.dir);
    expect(resumedImport?.ref).toBe(oldSha);
    // The resumed root holds the pinned content, not the dirty working tree.
    expect(readFileSlice(resumedImport!.rootDir, "a.txt").content).toBe("old");
    // No "working tree may have changed" warning: the session has a pinned SHA.
    expect(streams2.stderrText()).not.toContain("本地路径内容可能已变化");
  });

  it("does not pin a SHA for a subdirectory of a repo and warns on resume", async () => {
    const repo = await createTempRepo({ "sub/a.txt": "hello\n" });
    tempDirs.push(repo.dir);
    const subdir = join(repo.dir, "sub");
    const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
    tempDirs.push(cacheRoot);
    const dataDir = makeDataDir();

    const reader = recordingReader(createReader({ cacheRoot }));

    // The subdirectory is not a git root, so `headSha` reports "" and the id
    // stays a bare path (no `#sha` suffix).
    const imported = await reader.importRepository(subdir);
    expect(imported.sha).toBe("");
    expect(repositoryIdWithSha(imported)).toBe(subdir);

    // A session started from the subdirectory is stored without a pinned SHA.
    const session = new JsonSessionStore(dataDir).createSession({
      repositoryId: subdir,
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
    expect(resumedImport?.input).toBe(subdir);
    expect(resumedImport?.ref).toBeUndefined();
    // No clone: resume analyses the current working tree in place.
    expect(resumedImport?.rootDir).toBe(subdir);
    expect(streams.stderrText()).toContain("本地路径内容可能已变化");
  });
});
