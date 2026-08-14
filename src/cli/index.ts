/**
 * CLI commands.
 *
 * `repocoach start <url-or-path>` imports a repository, shows feature
 * candidates, runs the Q&A loop and renders the recap. `resume <sessionId>`
 * continues an interrupted session; `list` enumerates persisted sessions;
 * `show <sessionId>` renders one session's persisted turns and evidence.
 * All interaction uses node:readline/promises over injectable streams (no CLI
 * framework, zero new dependencies). See docs/architecture.md §3.
 */

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { FeatureCandidate } from "../domain/index.js";
import { resumeSession } from "../store/index.js";
import type { Repository } from "../reader/index.js";
import {
  buildRepositoryImport,
  type RepositoryImport,
  type WorkspaceInfo,
} from "../import/index.js";
import { assembleSession, type AssembleDeps, type SessionAssembly } from "./assemble.js";
import { lastFeedback, renderRecap, formatDuration } from "./recap.js";
import { renderInline } from "./markdown.js";
import { SessionRunner, type EventTarget, type PromptFn, type RunOutcome } from "./session-runner.js";
import { renderSessionShow } from "./show.js";
import type { CandidateScope } from "./candidates.js";

export { assembleSession, DEFAULT_DATA_DIR } from "./assemble.js";
export type { AssembleDeps, SessionAssembly } from "./assemble.js";
export {
  FixtureCandidateProvider,
  GeneratedCandidateProvider,
} from "./candidates.js";
export type { CandidateProvider, CandidateScope } from "./candidates.js";
export {
  SessionRunner,
  formatEvidence,
  renderDecision,
  renderEvidenceBlock,
  renderQuestion,
} from "./session-runner.js";
export type { RunOutcome, RunOutcomePhase } from "./session-runner.js";
export {
  collectEvidence,
  dedupeEvidence,
  formatDuration,
  lastFeedback,
  renderRecap,
  splitFeedback,
} from "./recap.js";
export { neutralizeMarkdown, renderInline, renderUntrustedBlock, stripTerminalControls } from "./markdown.js";
export { renderSessionShow } from "./show.js";
export type { ShowDeps } from "./show.js";

export type CliDeps = AssembleDeps;

interface Prompt {
  question: PromptFn;
  close(): void;
}

function makePrompt(stdin: Readable, stdout: Writable): Prompt {
  const rl = createInterface({ input: stdin, output: stdout });
  // `rl.question()` registers a one-shot 'line' listener, so lines buffered
  // ahead of the prompt (e.g. a scripted test stream) are dropped. A persistent
  // listener feeding a queue keeps every line regardless of arrival timing.
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      queue.push(line);
    }
  });
  // stdin EOF (Ctrl-D / a scripted stream ending) must release every pending
  // question instead of leaving the `question()` promise hanging forever — a
  // hung top-level await turns a clean end-of-input into exit 13. Resolving
  // with "" is the same "no input" every caller already treats as skip/default.
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter("");
    }
  });
  return {
    question(query) {
      stdout.write(query);
      const next = queue.shift();
      if (next !== undefined) {
        return Promise.resolve(next);
      }
      if (closed) {
        return Promise.resolve("");
      }
      return new Promise((resolvePromise) => waiters.push(resolvePromise));
    },
    close: () => rl.close(),
  };
}

/**
 * Run a CLI invocation. Returns the process exit code (0 success, 130 SIGINT is
 * handled inside the runner, 1 any error).
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const { command, arg, dataDir } = parseArgs(argv);
  const resolvedDeps = dataDir === undefined ? deps : { ...deps, dataDir };
  try {
    switch (command) {
      case "start":
        if (arg === undefined) {
          return usageError(deps, "start requires a <url-or-path>");
        }
        return await runStart(arg, resolvedDeps);
      case "resume":
        if (arg === undefined) {
          return usageError(deps, "resume requires a <sessionId>");
        }
        return await runResume(arg, resolvedDeps);
      case "list":
        return runList(resolvedDeps);
      case "show":
        if (arg === undefined) {
          return usageError(deps, "show requires a <sessionId>");
        }
        return runShow(arg, resolvedDeps);
      default:
        return usageError(deps, `unknown command "${renderInline(command)}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (deps.stderr ?? process.stderr).write(`Error: ${renderInline(message)}\n`);
    return 1;
  }
}

async function runStart(input: string, deps: CliDeps): Promise<number> {
  const asm = assembleSession(deps);
  const prompt = makePrompt(asm.stdin, asm.stdout);
  try {
    const repo = await asm.reader.importRepository(input);
    // Resolve the provider (accessing the lazy getter) up front so a missing
    // API key fails the start before any session file is written — a failed
    // start must never leave an empty active session behind.
    void asm.provider;
    const repoImport = buildRepositoryImport(asm.reader, repo);
    showImportSummary(asm.stdout, repoImport);
    showImportWarnings(asm.stderr, repoImport);
    const scope = await selectWorkspace(repoImport.workspaces, prompt.question, asm.stdout);
    const candidates = await asm.candidateProvider.listCandidates(repo, scope);
    const candidate = await selectCandidate(candidates, prompt.question, asm.stdout);
    const session = asm.store.createSession({
      repositoryId: repositoryIdWithSha(repo),
      featureId: candidate.id,
      ...(scope.workspacePath === undefined
        ? {}
        : { workspacePath: scope.workspacePath }),
    });
    const runner = buildRunner(asm, repo, session.id, featureGoal(candidate), prompt.question);
    const outcome = await runner.run();
    return await finishSession(asm, repo, session.id, outcome, prompt.question);
  } finally {
    prompt.close();
  }
}

async function runResume(sessionId: string, deps: CliDeps): Promise<number> {
  const asm = assembleSession(deps);
  const prompt = makePrompt(asm.stdin, asm.stdout);
  try {
    const resumed = resumeSession(asm.store, sessionId);
    const { input, sha } = splitRepositoryId(resumed.session.repositoryId);
    const repo = await asm.reader.importRepository(input, sha);
    if (sha === undefined) {
      if (repo.source.kind === "local") {
        asm.stderr.write(
          "Warning: 本地路径内容可能已变化，分析基于当前工作树。\n",
        );
      } else {
        asm.stderr.write(
          `Warning: session ${renderInline(resumed.sessionId)} has no pinned commit SHA; ` +
            `resuming against the current repository state (content may have changed).\n`,
        );
      }
    }
    // Rebuild the same scope the session was started with, so a workspace
    // narrowed on the first run does not widen to the whole repository (and
    // risk resolving a same-named candidate from another package) on resume.
    const scope: CandidateScope =
      resumed.session.workspacePath === undefined
        ? {}
        : { workspacePath: resumed.session.workspacePath };
    const candidates = await asm.candidateProvider.listCandidates(repo, scope);
    const goal = resolveFeatureGoal(candidates, resumed.session.featureId);
    const runner = buildRunner(asm, repo, resumed.sessionId, goal, prompt.question);
    const outcome = await runner.run();
    return await finishSession(asm, repo, resumed.sessionId, outcome, prompt.question);
  } finally {
    prompt.close();
  }
}

function buildRunner(
  asm: SessionAssembly,
  repo: Repository,
  sessionId: string,
  goal: string,
  prompt: PromptFn,
): SessionRunner {
  const target: EventTarget = { sink: null };
  const { orchestrator } = asm.buildOrchestrator(
    repo,
    sessionId,
    goal,
    (event) => target.sink?.push(event),
  );
  return new SessionRunner({
    orchestrator,
    store: asm.store,
    sessionId,
    stdout: asm.stdout,
    stderr: asm.stderr,
    prompt,
    target,
  });
}

function runList(deps: CliDeps): number {
  const asm = assembleSession(deps);
  const sessions = asm.store.listSessions();
  if (sessions.length === 0) {
    asm.stdout.write("(no sessions)\n");
    return 0;
  }
  for (const session of sessions) {
    const duration = asm.store.sessionDuration(session.id);
    asm.stdout.write(
      `${renderInline(session.id)}  ${renderInline(session.repositoryId)}  ${renderInline(session.phase)}  ${formatDuration(duration)}\n`,
    );
  }
  return 0;
}

function runShow(sessionId: string, deps: CliDeps): number {
  const asm = assembleSession(deps);
  // `listTurns`/`sessionDuration` throw `Unknown session` on a missing id, but
  // `getSession` returns undefined — check it first for a single clear message.
  const session = asm.store.getSession(sessionId);
  if (session === undefined) {
    throw new Error(`No session found: ${renderInline(sessionId)}`);
  }
  asm.stdout.write(
    renderSessionShow({
      session,
      turns: asm.store.listTurns(sessionId),
      durationMs: asm.store.sessionDuration(sessionId),
    }),
  );
  return 0;
}

async function finishSession(
  asm: SessionAssembly,
  repo: Repository,
  sessionId: string,
  outcome: RunOutcome,
  prompt: PromptFn,
): Promise<number> {
  if (outcome.phase === "abandoned") {
    // `/quit` marks the session abandoned, which `resumeSession` rejects — a
    // resume hint here would send the user down a path that always fails.
    asm.stdout.write(
      `\nSession ${renderInline(sessionId)} 已标记 abandoned，无法再恢复。可用 repocoach show ${renderInline(sessionId)} 查看已保存的内容，或 repocoach start 重新开始。\n`,
    );
    return 0;
  }
  if (outcome.phase === "error") {
    // The session is in a terminal phase, so `resumeSession` refuses it; point
    // the user at the persisted evidence (via `show`, which actually renders
    // it) instead of a resume that cannot work.
    asm.stderr.write(
      `Session ${renderInline(sessionId)} 进入 error 状态，无法继续。可用 repocoach show ${renderInline(sessionId)} 查看已保存的证据，或 repocoach start 重新开始新的学习。\n`,
    );
    return 1;
  }

  const turns = asm.store.listTurns(sessionId);
  const recap = renderRecap({
    sessionId,
    evidenceStore: asm.evidenceStore,
    reader: asm.reader,
    repo,
    turns,
    finalFeedback: lastFeedback(turns),
    durationMs: asm.store.sessionDuration(sessionId),
  });
  if (outcome.degraded) {
    asm.stderr.write(
      `⚠ 模型未能产出有效决策，已用已保存证据合成一份最小复盘。\n`,
    );
  }
  asm.stdout.write(`${recap}\n`);

  const selfAssessment = await prompt("你现在能向别人复述这条链路吗？(y/n) ");
  // The domain has no self-assessment field, so record it as an extra
  // LearningTurn rather than widening the schema (docs/mvp-spec.md §5.4).
  asm.store.appendTurn({
    sessionId,
    question: "你现在能向别人复述这条链路吗？",
    userAnswer: selfAssessment.trim(),
    evidence: [],
  });
  asm.stdout.write(`Session ${renderInline(sessionId)} 完成。\n`);
  return 0;
}

async function selectCandidate(
  candidates: FeatureCandidate[],
  prompt: PromptFn,
  stdout: Writable,
): Promise<FeatureCandidate> {
  if (candidates.length === 0) {
    throw new Error("No feature candidates available for this repository");
  }
  stdout.write("可学习的功能候选:\n");
  candidates.forEach((candidate, index) => {
    stdout.write(
      `  ${index + 1}. ${renderInline(candidate.title)} [${renderInline(candidate.difficulty)}] — ${renderInline(candidate.description)}\n`,
    );
    if (candidate.entryFiles.length > 0) {
      stdout.write(`     入口文件: ${candidate.entryFiles.map((file) => renderInline(file)).join(", ")}\n`);
    }
  });
  const line = await prompt(`选择编号 (1-${candidates.length}): `);
  const trimmed = line.trim();
  if (trimmed === "") {
    return candidates[0]!;
  }
  const index = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
    throw new Error(`Invalid selection: "${renderInline(trimmed)}"`);
  }
  return candidates[index - 1]!;
}

/** Show the imported repository's basic information (docs/mvp-spec.md §5.1). */
function showImportSummary(stdout: Writable, imp: RepositoryImport): void {
  stdout.write(
    `仓库: ${renderInline(imp.packageInfo?.name ?? repositoryIdFromRepo(imp.repo))}\n`,
  );
  stdout.write(`文件数: ${imp.tree.length}\n`);
  if (imp.entryCandidates.length > 0) {
    stdout.write(`入口候选: ${imp.entryCandidates.map((file) => renderInline(file)).join(", ")}\n`);
  }
  if (imp.workspaces.length > 0) {
    stdout.write("Workspaces:\n");
    for (const workspace of imp.workspaces) {
      stdout.write(
        `  - ${renderInline(workspace.path)}${workspace.name !== undefined ? ` (${renderInline(workspace.name)})` : ""}\n`,
      );
    }
  }
}

/** Surface non-fatal import observations (empty repo, missing package.json). */
function showImportWarnings(stderr: Writable, imp: RepositoryImport): void {
  for (const warning of imp.warnings) {
    stderr.write(`Warning: ${renderInline(warning)}\n`);
  }
  if (imp.packageError !== undefined) {
    stderr.write(`Warning: ${renderInline(imp.packageError)}\n`);
  }
}

/** For monorepos, ask the user to pick one workspace; otherwise scope to none. */
async function selectWorkspace(
  workspaces: WorkspaceInfo[],
  prompt: PromptFn,
  stdout: Writable,
): Promise<CandidateScope> {
  if (workspaces.length === 0) {
    return {};
  }
  stdout.write("检测到 monorepo，请选择要学习的 workspace:\n");
  workspaces.forEach((workspace, index) => {
    stdout.write(
      `  ${index + 1}. ${renderInline(workspace.path)}${workspace.name !== undefined ? ` (${renderInline(workspace.name)})` : ""}\n`,
    );
  });
  const line = await prompt(`选择编号 (1-${workspaces.length}): `);
  const trimmed = line.trim();
  if (trimmed === "") {
    return { workspacePath: workspaces[0]!.path };
  }
  const index = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(index) || index < 1 || index > workspaces.length) {
    throw new Error(`Invalid selection: "${renderInline(trimmed)}"`);
  }
  return { workspacePath: workspaces[index - 1]!.path };
}

function featureGoal(candidate: FeatureCandidate): string {
  return `${candidate.title} — ${candidate.description}`;
}

function resolveFeatureGoal(candidates: FeatureCandidate[], featureId: string): string {
  const candidate = candidates.find((item) => item.id === featureId);
  return candidate === undefined ? featureId : featureGoal(candidate);
}

function repositoryIdFromRepo(repo: Repository): string {
  if (repo.source.kind === "github") {
    return `https://github.com/${repo.source.owner}/${repo.source.name}`;
  }
  return repo.source.path;
}

/** A full git commit SHA — the suffix a session pins a repository to. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Persist the repository id together with the commit the session was started
 * at, as `url#sha`. A local path records its HEAD SHA only when it is itself a
 * git repo root whose working tree faithfully reproduces HEAD — clean (no
 * staged/modified/untracked files) and free of readable ignored files — so a
 * resume can pin that exact commit. A subdirectory of a repo, a non-git path,
 * or such a dirty tree has no SHA (`headSha` returns "") and stays a bare path.
 * A legacy id without `#` carries none either.
 */
export function repositoryIdWithSha(repo: Repository): string {
  const base = repositoryIdFromRepo(repo);
  return repo.sha === "" ? base : `${base}#${repo.sha}`;
}

/**
 * Split a persisted repository id back into the import input and the pinned
 * commit SHA (if one was recorded). A `#` not followed by a full SHA is left
 * in place, so local paths containing `#` survive a round-trip.
 */
export function splitRepositoryId(repositoryId: string): {
  input: string;
  sha?: string;
} {
  const hash = repositoryId.lastIndexOf("#");
  if (hash === -1) {
    return { input: repositoryId };
  }
  const candidate = repositoryId.slice(hash + 1);
  return FULL_SHA_RE.test(candidate)
    ? { input: repositoryId.slice(0, hash), sha: candidate }
    : { input: repositoryId };
}

function parseArgs(argv: string[]): {
  command: string;
  arg?: string;
  dataDir?: string;
} {
  const command = argv[0] ?? "";
  let arg: string | undefined;
  let dataDir: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--data-dir") {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg === undefined) {
      arg = argv[i];
    }
  }
  return { command, arg, dataDir };
}

function usageError(deps: CliDeps, message: string): number {
  const err = deps.stderr ?? process.stderr;
  err.write(`Error: ${renderInline(message)}\n`);
  err.write(
    "Usage:\n" +
      "  repocoach start <url-or-path> [--data-dir <dir>]\n" +
      "  repocoach resume <sessionId> [--data-dir <dir>]\n" +
      "  repocoach list [--data-dir <dir>]\n" +
      "  repocoach show <sessionId> [--data-dir <dir>]\n",
  );
  return 1;
}
