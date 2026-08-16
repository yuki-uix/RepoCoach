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

/**
 * Guarantee distinct ids across the final candidate list. Both generator exits
 * (heuristic and model) route through this single gate: two candidates can
 * legitimately carry the same id (a model returning duplicates, or two entry
 * paths that slug identically), and a session resume looks candidates up by id —
 * so duplicates are disambiguated here with a `-2`, `-3`, … suffix rather than
 * left to the call site.
 */
export function ensureUniqueCandidateIds(
  candidates: FeatureCandidate[],
): FeatureCandidate[] {
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    let id = candidate.id;
    if (seen.has(id)) {
      let suffix = 2;
      while (seen.has(`${id}-${suffix}`)) {
        suffix += 1;
      }
      id = `${id}-${suffix}`;
    }
    seen.add(id);
    return id === candidate.id ? candidate : { ...candidate, id };
  });
}

/**
 * Guarantee distinct titles across the final candidate list. Two candidates can
 * legitimately carry the same title — two files defining a same-named symbol, or
 * a model returning near-duplicates — and the learner's picker reads titles
 * first, so identical titles make the choices indistinguishable. A duplicate
 * title gets its defining entry file appended (or a numeric suffix when the
 * candidate has no entry file), which keeps the two choices tellable at a
 * glance.
 */
export function disambiguateCandidateTitles(
  candidates: FeatureCandidate[],
): FeatureCandidate[] {
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    let title = candidate.title;
    if (seen.has(title)) {
      const source = candidate.entryFiles[0];
      title = source === undefined ? `${candidate.title} #2` : `${candidate.title} (${source})`;
      let suffix = 2;
      while (seen.has(title)) {
        suffix += 1;
        title =
          source === undefined
            ? `${candidate.title} #${suffix}`
            : `${candidate.title} (${source}) #${suffix}`;
      }
    }
    seen.add(title);
    return title === candidate.title ? candidate : { ...candidate, title };
  });
}
