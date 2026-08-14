/**
 * Feature-candidate providers.
 *
 * The `CandidateProvider` seam the CLI drives. The fixture provider reads the
 * pre-authored candidate list for the local fixture repo; the generated
 * provider runs real candidate generation (issue #10) — `HeuristicCandidateGenerator`
 * by default, or an injected generator (e.g. the model-driven one) for tests.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  featureCandidateSchema,
  type FeatureCandidate,
} from "../domain/index.js";
import type { Reader, Repository } from "../reader/index.js";
import type { CandidateGenerator } from "../candidates/index.js";
import { HeuristicCandidateGenerator } from "../candidates/heuristic.js";
import { buildRepositoryImport, narrowToWorkspace } from "../import/index.js";

/** Optional monorepo narrowing — candidates are scoped to this workspace. */
export interface CandidateScope {
  workspacePath?: string;
}

/** Seam producing the learning candidates for a repository. */
export interface CandidateProvider {
  listCandidates(
    repo: Repository,
    scope?: CandidateScope,
  ): Promise<FeatureCandidate[]>;
}

/**
 * Reads the fixture's pre-authored candidates from
 * `fixtures/expectations/feature-candidates.json` (at the RepoCoach repo root,
 * not inside the fixture itself). The path is supplied by the assembler, which
 * knows the RepoCoach root.
 */
export class FixtureCandidateProvider implements CandidateProvider {
  constructor(private readonly candidatesPath: string) {}

  async listCandidates(): Promise<FeatureCandidate[]> {
    const raw = readFileSync(this.candidatesPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid fixture candidates JSON at ${this.candidatesPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return z.array(featureCandidateSchema).parse(parsed);
  }
}

/** Runs a real generator over the imported repository (optionally scoped). */
export class GeneratedCandidateProvider implements CandidateProvider {
  private readonly generator: CandidateGenerator;

  constructor(
    private readonly reader: Reader,
    generator?: CandidateGenerator,
  ) {
    this.generator = generator ?? new HeuristicCandidateGenerator();
  }

  async listCandidates(
    repo: Repository,
    scope?: CandidateScope,
  ): Promise<FeatureCandidate[]> {
    const imp = buildRepositoryImport(this.reader, repo);
    let tree = imp.tree;
    let entryCandidates = imp.entryCandidates;
    let workspacePath: string | undefined;
    if (scope?.workspacePath !== undefined) {
      workspacePath = scope.workspacePath;
      const narrowed = narrowToWorkspace(imp, workspacePath);
      tree = narrowed.tree;
      entryCandidates = narrowed.entryCandidates;
    }
    return this.generator.generate({
      reader: this.reader,
      repo,
      tree,
      entryCandidates,
      packageInfo: imp.packageInfo,
      workspacePath,
    });
  }
}
