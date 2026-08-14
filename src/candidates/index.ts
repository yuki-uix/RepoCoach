/**
 * Feature-candidate generation seam.
 *
 * Two generators produce the learning candidates for a repository:
 * `HeuristicCandidateGenerator` (deterministic, no model) and
 * `ModelCandidateGenerator` (optional, a ChatProvider that must return a strict
 * JSON schema). Both return candidates that pass `featureCandidateSchema` and
 * whose `entryFiles` exist in the tree — `filterCandidatesToTree` is the shared
 * anti-hallucination gate (a path the tree does not contain is dropped).
 */

import {
  featureCandidateSchema,
  type FeatureCandidate,
} from "../domain/index.js";
import type {
  PackageInfo,
  Reader,
  Repository,
  TreeEntry,
} from "../reader/index.js";

export interface CandidateGeneratorInput {
  reader: Reader;
  repo: Repository;
  /** Already scoped to a workspace when one is selected. */
  tree: TreeEntry[];
  entryCandidates: string[];
  packageInfo: PackageInfo | null;
  /** Selected workspace directory, when the import was narrowed. */
  workspacePath?: string;
}

export interface CandidateGenerator {
  generate(input: CandidateGeneratorInput): Promise<FeatureCandidate[]>;
}

/**
 * Keep only candidates whose entry files all exist in the tree. A candidate
 * with a non-empty `entryFiles` must never reference a file the reader would
 * refuse or the tree does not list.
 */
export function filterCandidatesToTree(
  candidates: FeatureCandidate[],
  tree: TreeEntry[],
): FeatureCandidate[] {
  const paths = new Set(tree.map((entry) => entry.path));
  return candidates.filter((candidate) =>
    candidate.entryFiles.every((path) => paths.has(path)),
  );
}

/** Drop candidates that do not satisfy `featureCandidateSchema`. */
export function validateCandidates(
  candidates: FeatureCandidate[],
): FeatureCandidate[] {
  const result: FeatureCandidate[] = [];
  for (const candidate of candidates) {
    const parsed = featureCandidateSchema.safeParse(candidate);
    if (parsed.success) {
      result.push(parsed.data);
    }
  }
  return result;
}
