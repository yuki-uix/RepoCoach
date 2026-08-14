/**
 * Feature-candidate providers.
 *
 * Candidate *generation* is issue #10 and not implemented here. This module
 * defines the `CandidateProvider` seam the CLI depends on plus two stand-ins:
 * a fixture provider that reads the pre-authored candidate list for the local
 * fixture repo, and a placeholder that guesses a single provisional candidate
 * from the entry file for any other repository. See docs/architecture.md §3.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  featureCandidateSchema,
  type FeatureCandidate,
} from "../domain/index.js";
import type { Reader, Repository } from "../reader/index.js";

/** Seam producing the learning candidates for a repository (replaced by #10). */
export interface CandidateProvider {
  listCandidates(repo: Repository): FeatureCandidate[];
}

/**
 * Reads the fixture's pre-authored candidates from
 * `fixtures/expectations/feature-candidates.json` (at the RepoCoach repo root,
 * not inside the fixture itself). The path is supplied by the assembler, which
 * knows the RepoCoach root.
 */
export class FixtureCandidateProvider implements CandidateProvider {
  constructor(private readonly candidatesPath: string) {}

  listCandidates(): FeatureCandidate[] {
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

const ENTRY_CANDIDATES = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/index.mjs",
  "index.ts",
  "index.js",
  "src/main.ts",
  "src/main.js",
];

/**
 * Provisional single-candidate provider for non-fixture repositories. Guesses
 * one candidate from the entry file; issue #10 replaces this with real
 * candidate generation.
 */
export class PlaceholderProvider implements CandidateProvider {
  constructor(private readonly reader: Reader) {}

  listCandidates(repo: Repository): FeatureCandidate[] {
    const entryFile = guessEntryFile(this.reader, repo);
    return [
      {
        id: "provisional-entry-point",
        title: "Entry-point walkthrough",
        description:
          "Auto-guessed from the repository's entry file (provisional — candidate generation is issue #10).",
        entryFiles: entryFile === undefined ? [] : [entryFile],
        difficulty: "intro",
      },
    ];
  }
}

/** Guess a repository entry file from the readable tree (index → first source). */
function guessEntryFile(reader: Reader, repo: Repository): string | undefined {
  const paths = reader.getTree(repo).map((entry) => entry.path);
  for (const candidate of ENTRY_CANDIDATES) {
    if (paths.includes(candidate)) {
      return candidate;
    }
  }
  return paths.find((path) => /\.(?:ts|tsx|js|jsx|mjs)$/.test(path));
}
