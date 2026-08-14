/**
 * Deterministic feature-candidate generator (no model call).
 *
 * For each entry candidate file, it finds the top-level exported functions /
 * classes (`export function X` / `export class X`), ranks them by how many other
 * files reference the symbol (via the reader's ripgrep `search`), and turns the
 * 1–3 most central into `FeatureCandidate`s. Difficulty is a rough call-chain
 * estimate: the max depth of the local import graph rooted at the entry file.
 *
 * When nothing exportable is found (or the repository has no entry candidates
 * at all), a single "walkthrough" candidate keeps the import flow usable.
 */

import type { FeatureCandidate } from "../domain/index.js";
import type { Reader, Repository } from "../reader/index.js";
import {
  filterCandidatesToTree,
  validateCandidates,
  type CandidateGenerator,
  type CandidateGeneratorInput,
} from "./index.js";

interface FoundSymbol {
  name: string;
  kind: "function" | "class";
}

interface RankedSymbol {
  entryFile: string;
  symbol: FoundSymbol;
  references: number;
  difficulty: FeatureCandidate["difficulty"];
}

const EXPORTED_SYMBOL_RE =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;

const IMPORT_SPECIFIER_RES = [
  /\bfrom\s+["'](\.[^"']*)["']/g,
  /\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g,
  /\bimport\s+["'](\.[^"']*)["']/g,
];

export class HeuristicCandidateGenerator implements CandidateGenerator {
  async generate(input: CandidateGeneratorInput): Promise<FeatureCandidate[]> {
    const ranked: RankedSymbol[] = [];
    for (const entryFile of input.entryCandidates) {
      const difficulty = await this.estimateDifficulty(input, entryFile);
      const symbols = await this.exportedSymbols(input.reader, input.repo, entryFile);
      for (const symbol of symbols) {
        const references = await this.countReferences(
          input.reader,
          input.repo,
          entryFile,
          symbol.name,
        );
        ranked.push({ entryFile, symbol, references, difficulty });
      }
    }

    ranked.sort((a, b) => b.references - a.references);
    const candidates = ranked.slice(0, 3).map((item) =>
      this.symbolCandidate(item),
    );
    if (candidates.length === 0) {
      candidates.push(this.fallbackCandidate(input));
    }

    return ensureUniqueCandidateIds(
      filterCandidatesToTree(validateCandidates(candidates), input.tree),
    );
  }

  private async exportedSymbols(
    reader: Reader,
    repo: Repository,
    entryFile: string,
  ): Promise<FoundSymbol[]> {
    let content: string;
    try {
      content = reader.readFile(repo, entryFile).content;
    } catch {
      return [];
    }

    const symbols: FoundSymbol[] = [];
    const seen = new Set<string>();
    for (const match of content.matchAll(EXPORTED_SYMBOL_RE)) {
      const name = match[1];
      if (name === undefined || seen.has(name)) {
        continue;
      }
      seen.add(name);
      symbols.push({
        name,
        kind: match[0].includes("class") ? "class" : "function",
      });
    }
    return symbols;
  }

  private async countReferences(
    reader: Reader,
    repo: Repository,
    entryFile: string,
    symbol: string,
  ): Promise<number> {
    const matches = await reader.search(repo, symbol);
    const files = new Set<string>();
    for (const match of matches) {
      if (match.path !== entryFile) {
        files.add(match.path);
      }
    }
    return files.size;
  }

  private symbolCandidate(item: RankedSymbol): FeatureCandidate {
    const { symbol } = item;
    const title =
      symbol.kind === "class"
        ? `Understand the ${symbol.name} class`
        : `Trace the ${symbol.name} call chain`;
    const subject = symbol.kind === "class" ? "class" : "function";
    return {
      // Include the entry file so two files exporting the same symbol name
      // (e.g. `export function main` in two workspaces) do not collide.
      id: `heuristic-${slug(item.entryFile)}-${slug(symbol.name)}`,
      title,
      description:
        `Follow the ${symbol.name} ${subject} starting from ` +
        `${item.entryFile} and explain what each step does and how the ` +
        `pieces fit together.`,
      entryFiles: [item.entryFile],
      difficulty: item.difficulty,
    };
  }

  private fallbackCandidate(input: CandidateGeneratorInput): FeatureCandidate {
    const entry = input.entryCandidates[0];
    return {
      id: "repository-walkthrough",
      title: "Repository walkthrough",
      description:
        "Survey the repository's structure, entry points and main modules.",
      entryFiles: entry === undefined ? [] : [entry],
      difficulty: "intro",
    };
  }

  private async estimateDifficulty(
    input: CandidateGeneratorInput,
    entryFile: string,
  ): Promise<FeatureCandidate["difficulty"]> {
    const depth = await this.callChainDepth(input, entryFile);
    if (depth <= 1) {
      return "intro";
    }
    if (depth === 2) {
      return "intermediate";
    }
    return "advanced";
  }

  /** Max hop depth of the local import graph rooted at `entryFile`. */
  private async callChainDepth(
    input: CandidateGeneratorInput,
    entryFile: string,
  ): Promise<number> {
    const paths = new Set(input.tree.map((entry) => entry.path));
    const queue: Array<{ path: string; depth: number }> = [
      { path: entryFile, depth: 0 },
    ];
    const visited = new Set<string>([entryFile]);
    let maxDepth = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      maxDepth = Math.max(maxDepth, current.depth);
      for (const next of await this.localImports(
        input.reader,
        input.repo,
        current.path,
        paths,
      )) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ path: next, depth: current.depth + 1 });
        }
      }
    }
    return maxDepth;
  }

  private async localImports(
    reader: Reader,
    repo: Repository,
    file: string,
    treePaths: Set<string>,
  ): Promise<string[]> {
    let content: string;
    try {
      content = reader.readFile(repo, file).content;
    } catch {
      return [];
    }

    const baseDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const specifiers = new Set<string>();
    for (const pattern of IMPORT_SPECIFIER_RES) {
      for (const match of content.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier !== undefined) {
          specifiers.add(specifier);
        }
      }
    }

    const resolved: string[] = [];
    for (const specifier of specifiers) {
      const path = resolveImportSpecifier(baseDir, specifier, treePaths);
      if (path !== null && path !== file) {
        resolved.push(path);
      }
    }
    return resolved;
  }
}

function resolveImportSpecifier(
  baseDir: string,
  specifier: string,
  treePaths: Set<string>,
): string | null {
  const joined = joinPosix(baseDir, specifier);
  if (joined === null) {
    return null;
  }
  for (const candidate of fileVariants(joined)) {
    if (treePaths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function fileVariants(path: string): string[] {
  const variants = [path];
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"]) {
    variants.push(path + ext);
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    variants.push(`${path}/index${ext}`);
  }
  return variants;
}

function joinPosix(baseDir: string, specifier: string): string | null {
  const base = baseDir === "" || baseDir === "." ? [] : baseDir.split("/");
  const out: string[] = [];
  for (const part of [...base, ...specifier.split("/")]) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length === 0) {
        return null; // escaped the repository root
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? null : out.join("/");
}

function slug(name: string): string {
  const value = name
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return value === "" ? "candidate" : value;
}

/**
 * Guarantee distinct ids across the final candidate list. Two entry paths can
 * slug to the same id (e.g. `src/foo-bar.ts` and `src/foo/bar.ts`), so when an
 * id is already taken append a `-2`, `-3`, … sequence until it is unique.
 */
function ensureUniqueCandidateIds(
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
