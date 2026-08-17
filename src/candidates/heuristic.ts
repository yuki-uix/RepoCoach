/**
 * Deterministic feature-candidate generator (no model call).
 *
 * For each entry candidate file, it finds the top-level exported functions /
 * classes (`export function X` / `export class X`), ranks them by how many other
 * files reference the symbol (via the reader's ripgrep `search`), and turns the
 * 1–3 most central into `FeatureCandidate`s. Difficulty is a rough call-chain
 * estimate: the max depth of the local import graph rooted at the entry file.
 *
 * Mature libraries expose a *barrel* at their entry (`export * from "./x"`),
 * often several layers deep, with no `export function`/`class` in the barrel
 * itself. To keep candidates real, exported-symbol discovery follows those
 * re-exports to the files that actually define the symbols, and points each
 * candidate's `entryFiles` at the defining file (not the barrel). The traversal
 * is bounded — see `MAX_REEXPORT_DEPTH` / `MAX_REEXPORT_FILES` below — and every
 * read still goes through the reader's dual gate (fs-guard + filters).
 *
 * When nothing exportable is found (or the repository has no entry candidates
 * at all), a single "walkthrough" candidate keeps the import flow usable.
 */

import type { FeatureCandidate } from "../domain/index.js";
import type { Reader, Repository } from "../reader/index.js";
import {
  disambiguateCandidateTitles,
  ensureUniqueCandidateIds,
  filterCandidatesToTree,
  validateCandidates,
  type CandidateGenerator,
  type CandidateGeneratorInput,
} from "./index.js";

export interface FoundSymbol {
  name: string;
  kind: "function" | "class";
  /** 1-based line of the `export` keyword in the defining file. */
  line: number;
}

/** An exportable symbol together with the file that actually defines it. */
interface LocatedSymbol {
  file: string;
  symbol: FoundSymbol;
}

/**
 * A barrel-penetrated symbol ready for candidate generation: the file that
 * actually defines it plus the entry candidate that re-exported it. Exposed so
 * the model generator can propose candidates over these real definitions.
 */
export interface ResolvedSymbol {
  /** The file that defines the symbol (the candidate's real entry file). */
  file: string;
  symbol: FoundSymbol;
  /** The entry candidate that re-exports it (may equal `file`). */
  exportedFrom: string;
}

interface RankedSymbol {
  /** The file that defines the symbol (the candidate's real entry file). */
  entryFile: string;
  /** The entry candidate that re-exports it (may equal `entryFile`). */
  exportedFrom: string;
  symbol: FoundSymbol;
  references: number;
  difficulty: FeatureCandidate["difficulty"];
}

/**
 * How many re-export hops to follow from an entry file before giving up.
 * `entry (0) → barrel (1) → barrel (2) → definition (3)` is reachable; a
 * definition any deeper is dropped. Real libraries rarely nest barrels beyond
 * this, and the bound is what prevents a pathological repo from forcing a deep
 * (or cyclic) traversal — the cycle guard is the visited set in
 * `collectExportedSymbols`, but the depth cap is the hard stop.
 */
const MAX_REEXPORT_DEPTH = 3;

/**
 * Hard cap on the number of distinct files scanned while penetrating barrels.
 * On a huge monorepo an entry can fan out through many re-exports; this keeps
 * candidate generation a bounded number of reads regardless of repo size.
 */
const MAX_REEXPORT_FILES = 40;

const EXPORTED_SYMBOL_RE =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;

/**
 * `export … from "…"` re-export statements (the barrel forms). `[^"';]` keeps
 * the match inside one statement: the `from` clause always precedes the closing
 * `;`, and a `"`/`'` would begin a string literal, so neither can legally sit
 * between `export` and `from`. The captured specifier must start with `.`
 * (relative); bare package specifiers are left for the caller's tree to rule
 * out, but are never followed anyway.
 */
const REEXPORT_FROM_RE = /\bexport\s+[^"';]*?\bfrom\s+["'](\.[^"']*)["']/g;

const IMPORT_SPECIFIER_RES = [
  /\bfrom\s+["'](\.[^"']*)["']/g,
  /\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g,
  /\bimport\s+["'](\.[^"']*)["']/g,
];

export class HeuristicCandidateGenerator implements CandidateGenerator {
  async generate(input: CandidateGeneratorInput): Promise<FeatureCandidate[]> {
    const difficultyByFile = new Map<string, FeatureCandidate["difficulty"]>();

    const ranked: RankedSymbol[] = [];
    for (const located of await this.resolveSymbols(input)) {
      const references = await this.countReferences(
        input.reader,
        input.repo,
        located.file,
        located.symbol.name,
      );
      let difficulty = difficultyByFile.get(located.file);
      if (difficulty === undefined) {
        difficulty = await this.estimateDifficulty(input, located.file);
        difficultyByFile.set(located.file, difficulty);
      }
      ranked.push({
        entryFile: located.file,
        exportedFrom: located.exportedFrom,
        symbol: located.symbol,
        references,
        difficulty,
      });
    }

    ranked.sort((a, b) => b.references - a.references);
    const candidates = ranked.slice(0, 3).map((item) =>
      this.symbolCandidate(item),
    );
    if (candidates.length === 0) {
      candidates.push(this.fallbackCandidate(input));
    }

    return disambiguateCandidateTitles(
      ensureUniqueCandidateIds(
        filterCandidatesToTree(validateCandidates(candidates), input.tree),
      ),
    );
  }

  /**
   * Resolve the exportable symbols reachable from every entry candidate,
   * following re-export barrels, and collapse duplicates (file + name) so a
   * shared core module does not repeat for every entry that re-exports it. The
   * model generator reuses this same resolution so it proposes candidates over
   * the real definitions rather than inventing symbols.
   */
  async resolveSymbols(input: CandidateGeneratorInput): Promise<ResolvedSymbol[]> {
    const treePaths = new Set(input.tree.map((entry) => entry.path));
    return resolveExportedSymbols(input.reader, input.repo, input.entryCandidates, treePaths);
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
    const exportedFrom =
      item.entryFile === item.exportedFrom
        ? ""
        : ` (exported from ${item.exportedFrom})`;
    return {
      // Include the defining file so two files exporting the same symbol name
      // (e.g. `export function main` in two workspaces) do not collide.
      id: `heuristic-${slug(item.entryFile)}-${slug(symbol.name)}`,
      title,
      description:
        `Follow the ${symbol.name} ${subject} starting from ` +
        `${item.entryFile}${exportedFrom} and explain what each step does and ` +
        `how the pieces fit together.`,
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

/**
 * Resolve the exportable symbols reachable from each entry candidate, following
 * re-export barrels, and collapse duplicates by (file, name). Shared by
 * `HeuristicCandidateGenerator.resolveSymbols` (candidate generation) and the
 * agent loop's first-turn entry outline (issue #29), so the outline is built
 * from the exact same barrel-penetrated definitions the candidates were
 * grounded on — never a parallel, divergent parse.
 */
export async function resolveExportedSymbols(
  reader: Reader,
  repo: Repository,
  entryCandidates: string[],
  treePaths: Set<string>,
): Promise<ResolvedSymbol[]> {
  const seenSymbols = new Set<string>();
  const resolved: ResolvedSymbol[] = [];
  for (const entryFile of entryCandidates) {
    const symbols = await collectExportedSymbols(reader, repo, entryFile, treePaths);
    for (const located of symbols) {
      const key = `${located.file}:${located.symbol.name}`;
      if (seenSymbols.has(key)) {
        continue;
      }
      seenSymbols.add(key);
      resolved.push({
        file: located.file,
        symbol: located.symbol,
        exportedFrom: entryFile,
      });
    }
  }
  return resolved;
}

/**
 * Collect exportable functions/classes reachable from `entryFile`, following
 * re-export barrels. Returns each symbol with the file that defines it.
 */
async function collectExportedSymbols(
  reader: Reader,
  repo: Repository,
  entryFile: string,
  treePaths: Set<string>,
): Promise<LocatedSymbol[]> {
  const located: LocatedSymbol[] = [];
  // Visited set is the cycle guard: a re-export loop (a → b → a) terminates
  // because an already-scanned file is never re-enqueued.
  const visited = new Set<string>([entryFile]);
  const queue: Array<{ path: string; depth: number }> = [
    { path: entryFile, depth: 0 },
  ];

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    let content: string;
    try {
      content = reader.readFile(repo, path).content;
    } catch {
      continue;
    }

    for (const symbol of parseExportedSymbols(content)) {
      located.push({ file: path, symbol });
    }

    if (depth < MAX_REEXPORT_DEPTH) {
      for (const next of resolveReExports(content, path, treePaths)) {
        if (visited.has(next)) {
          continue;
        }
        if (visited.size >= MAX_REEXPORT_FILES) {
          continue;
        }
        visited.add(next);
        queue.push({ path: next, depth: depth + 1 });
      }
    }
  }

  return located;
}

/** Top-level `export function` / `export class` declarations in one file. */
function parseExportedSymbols(content: string): FoundSymbol[] {
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
      line: lineNumberOf(content, match.index),
    });
  }
  return symbols;
}

/** 1-based line number of a character offset within `content`. */
function lineNumberOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * Resolve the target files of a file's `export … from "…"` statements. The
 * specifiers are untrusted repository content, so they are never used to
 * build a path directly: `resolveImportSpecifier` normalises with `joinPosix`
 * (which rejects `..` escapes) and only returns a path that actually appears
 * in the reader's tree.
 */
function resolveReExports(
  content: string,
  file: string,
  treePaths: Set<string>,
): string[] {
  const baseDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const specifiers = new Set<string>();
  for (const match of content.matchAll(REEXPORT_FROM_RE)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.add(specifier);
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
  // TypeScript ESM source conventionally writes relative specifiers with a
  // `.js` extension even though the file on disk is `.ts` (NodeNext mapping).
  // A compiled-path barrel (`export * from "./x.js"`) must still resolve to the
  // checked-in `x.ts` source.
  for (const [from, to] of [
    [".js", ".ts"],
    [".mjs", ".ts"],
    [".cjs", ".ts"],
    [".jsx", ".tsx"],
  ] as const) {
    if (path.endsWith(from)) {
      variants.push(path.slice(0, -from.length) + to);
    }
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
