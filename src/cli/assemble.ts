/**
 * Session assembly — wires every external dependency into the runtime graph
 * the CLI drives.
 *
 * Production path: `.env.local` API key → DeepSeekProvider → Reader → grounding
 * (ledger + evidence store + validator) → AgentLoop → JsonSessionStore →
 * Orchestrator. Every external dependency (provider, reader, store, evidence
 * store, candidate provider, the three streams) is injectable for tests.
 *
 * Mandatory grounding: `buildOrchestrator` unconditionally injects the
 * `GroundingEvidenceValidator` — there is deliberately no switch back to
 * `acceptAllEvidence` here (docs/architecture.md §6: the grounding validator is
 * a mandatory injection at the production assembly point).
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AgentLoop,
  DeepSeekProvider,
  DEFAULT_DEEPSEEK_MODEL,
  toInvoker,
  type AgentLoopEvent,
  type ChatProvider,
} from "../agent/index.js";
import { loadConfig, type Config } from "../config.js";
import {
  GroundingEvidenceValidator,
  InMemoryEvidenceStore,
  ToolReturnLedger,
  type EvidenceStore,
} from "../evidence/index.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { createReader, type Reader, type Repository } from "../reader/index.js";
import { JsonSessionStore, type PersistentSessionStore } from "../store/index.js";
import { HeuristicCandidateGenerator } from "../candidates/heuristic.js";
import { ModelCandidateGenerator } from "../candidates/model.js";
import {
  FixtureCandidateProvider,
  GeneratedCandidateProvider,
  type CandidateProvider,
} from "./candidates.js";

/** Default session store root: `~/.repocoach`. */
export const DEFAULT_DATA_DIR = join(homedir(), ".repocoach");

/** The RepoCoach project root, resolved from this module's location. */
function defaultRepoRoot(): string {
  // src/cli/assemble.ts and dist/cli/assemble.js are both two levels below the
  // project root, so `../../` resolves to it in both source and build runs.
  return fileURLToPath(new URL("../../", import.meta.url));
}

export interface AssembleDeps {
  /** Session store root (default `~/.repocoach`). */
  dataDir?: string;
  /** `.env.local` path for the production provider (default `<repoRoot>/.env.local`). */
  envFilePath?: string;
  /** Pre-loaded config — bypasses `.env.local` (test seam). */
  config?: Config;
  /** Model provider override (test seam). */
  provider?: ChatProvider;
  /** Reader override (test seam). */
  reader?: Reader;
  /** Session store override (test seam). */
  store?: PersistentSessionStore;
  /** Evidence store override (test seam). */
  evidenceStore?: EvidenceStore;
  /** Candidate provider override (test seam). */
  candidateProvider?: CandidateProvider;
  /** Clone cache root override. */
  cacheRoot?: string;
  /** RepoCoach project root (defaults to the module location). */
  repoRoot?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

export interface BuiltOrchestrator {
  orchestrator: Orchestrator;
  loop: AgentLoop;
}

/** Per-session build options (beyond the injected dependencies). */
export interface BuildOrchestratorOptions {
  /**
   * Whether the AgentLoop carries already-read ranges across turns (issue #25).
   * Defaults to true; `false` reproduces pre-optimisation behaviour for A/B.
   */
  carryReadContext?: boolean;
  /**
   * Entry files of the selected feature candidate. When set, the loop preloads
   * a byte-capped structure outline of their top-level exports on the first
   * turn (issue #29).
   */
  entryFiles?: string[];
}

export interface SessionAssembly {
  reader: Reader;
  provider: ChatProvider;
  store: PersistentSessionStore;
  evidenceStore: EvidenceStore;
  candidateProvider: CandidateProvider;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /**
   * Build an Orchestrator (and its AgentLoop) for a specific session. A fresh
   * ledger + grounding validator are created per session — grounding is scoped
   * to (session, turn).
   */
  buildOrchestrator(
    repo: Repository,
    sessionId: string,
    featureGoal: string,
    onEvent?: (event: AgentLoopEvent) => void,
    opts?: BuildOrchestratorOptions,
  ): BuiltOrchestrator;
}

export function assembleSession(deps: AssembleDeps = {}): SessionAssembly {
  const repoRoot = deps.repoRoot ?? defaultRepoRoot();
  const dataDir = deps.dataDir ?? DEFAULT_DATA_DIR;
  const reader =
    deps.reader ?? createReader({ cacheRoot: deps.cacheRoot ?? join(dataDir, "repos") });
  const store = deps.store ?? new JsonSessionStore(dataDir);
  const evidenceStore = deps.evidenceStore ?? new InMemoryEvidenceStore();

  // `list`/`show` never touch the provider, so defer `loadConfig` (and the
  // `.env.local` read it implies) until something actually asks for it — the
  // first `buildOrchestrator`, an explicit `provider` access, or the first
  // candidate generation for a non-fixture repository. This keeps `list` and
  // `show` working without an API key.
  let provider: ChatProvider | undefined;
  const getProvider = (): ChatProvider => {
    if (provider === undefined) {
      provider = deps.provider ?? buildDefaultProvider(deps, repoRoot);
    }
    return provider;
  };

  const candidateProvider =
    deps.candidateProvider ?? defaultCandidateProvider(reader, repoRoot, getProvider);

  return {
    reader,
    get provider() {
      return getProvider();
    },
    store,
    evidenceStore,
    candidateProvider,
    stdin: deps.stdin ?? process.stdin,
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    buildOrchestrator(repo, sessionId, featureGoal, onEvent, opts) {
      const ledger = new ToolReturnLedger();
      const validator = new GroundingEvidenceValidator({
        ledger,
        store: evidenceStore,
        sessionId,
      });
      const loop = new AgentLoop({
        provider: getProvider(),
        reader,
        repo,
        model: DEFAULT_DEEPSEEK_MODEL,
        evidenceValidator: validator,
        ledger,
        carryReadContext: opts?.carryReadContext,
        entryFiles: opts?.entryFiles,
        onEvent,
      });
      // A resumed session carries its cumulative token usage; pass it through so
      // the budget limit keeps counting across interrupts instead of resetting.
      const session = store.getSession(sessionId);
      return {
        orchestrator: new Orchestrator({
          agent: toInvoker(loop),
          store,
          sessionId,
          featureGoal,
          initialUsage: session?.usage,
        }),
        loop,
      };
    },
  };
}

/** Build the production DeepSeek provider from `.env.local` (or injected config). */
function buildDefaultProvider(deps: AssembleDeps, repoRoot: string): ChatProvider {
  const config = deps.config ?? loadConfig(deps.envFilePath ?? join(repoRoot, ".env.local"));
  return new DeepSeekProvider({
    apiKey: config.deepseekKey,
    model: DEFAULT_DEEPSEEK_MODEL,
  });
}

/**
 * Route candidate generation: a local path at (or under) the `fixture-repo`
 * directory uses the pre-authored fixture candidates; anything else — including
 * `fixture-monorepo` — gets the model-driven generator, falling back to the
 * deterministic heuristic when the model fails or returns nothing usable.
 *
 * The model generator is constructed lazily, on the first non-fixture
 * `listCandidates` call, so `list`/`show` (which never call `listCandidates`)
 * keep working without an API key.
 */
function defaultCandidateProvider(
  reader: Reader,
  repoRoot: string,
  getProvider: () => ChatProvider,
): CandidateProvider {
  const fixture = new FixtureCandidateProvider(
    join(repoRoot, "fixtures", "expectations", "feature-candidates.json"),
  );
  const fixtureRepoRoot = resolve(repoRoot, "fixtures", "fixture-repo");
  let generated: CandidateProvider | undefined;
  return {
    async listCandidates(repo, scope) {
      if (repo.source.kind === "local") {
        const path = resolve(repo.source.path);
        if (path === fixtureRepoRoot || path.startsWith(fixtureRepoRoot + sep)) {
          return fixture.listCandidates();
        }
      }
      if (generated === undefined) {
        generated = new GeneratedCandidateProvider(
          reader,
          new ModelCandidateGenerator({
            provider: getProvider(),
            heuristic: new HeuristicCandidateGenerator(),
          }),
        );
      }
      return generated.listCandidates(repo, scope);
    },
  };
}
