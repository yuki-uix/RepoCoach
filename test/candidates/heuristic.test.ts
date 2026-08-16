import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterCandidatesToTree,
  type CandidateGenerator,
  type CandidateGeneratorInput,
} from "../../src/candidates";
import { HeuristicCandidateGenerator } from "../../src/candidates/heuristic";
import { featureCandidateSchema, type FeatureCandidate } from "../../src/domain";
import { buildRepositoryImport, narrowToWorkspace } from "../../src/import";
import { createReader, type Reader } from "../../src/reader";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");
const monorepoRoot = join(repoRoot, "fixtures", "fixture-monorepo");
const whitelistPath = join(
  repoRoot,
  "fixtures",
  "expectations",
  "feature-candidates.json",
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeReader(): Reader {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-candidates-"));
  tempDirs.push(cacheRoot);
  return createReader({ cacheRoot });
}

/** Write a repo file map (rel path → content) into a fresh temp directory. */
function writeRepoFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

/** Import a temp repo described by `files` and run the heuristic generator. */
async function generateFor(
  files: Record<string, string>,
): Promise<FeatureCandidate[]> {
  const reader = makeReader();
  const dir = mkdtempSync(join(tmpdir(), "repocoach-barrel-"));
  tempDirs.push(dir);
  writeRepoFiles(dir, files);
  const repo = await reader.importRepository(dir);
  const imp = buildRepositoryImport(reader, repo);
  return new HeuristicCandidateGenerator().generate({
    reader,
    repo,
    tree: imp.tree,
    entryCandidates: imp.entryCandidates,
    packageInfo: imp.packageInfo,
  });
}

function pkg(main: string): string {
  return JSON.stringify({ name: "fixture", version: "0.1.0", main });
}

describe("HeuristicCandidateGenerator", () => {
  it("hits the pre-authored candidate whitelist on the fixture repo (AC1)", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);
    const generator = new HeuristicCandidateGenerator();
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    const whitelist = JSON.parse(
      readFileSync(whitelistPath, "utf8"),
    ) as Array<{ entryFiles: string[] }>;
    const whitelistEntries = new Set(whitelist.flatMap((c) => c.entryFiles));
    expect(
      candidates.some((candidate) =>
        candidate.entryFiles.some((path) => whitelistEntries.has(path)),
      ),
    ).toBe(true);
  });

  it("produces only schema-valid candidates with real entry files (AC4)", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);
    const generator = new HeuristicCandidateGenerator();
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    const treePaths = new Set(imp.tree.map((entry) => entry.path));
    for (const candidate of candidates) {
      expect(featureCandidateSchema.safeParse(candidate).success).toBe(true);
      for (const path of candidate.entryFiles) {
        expect(treePaths.has(path)).toBe(true);
      }
    }
  });

  it("scopes candidates to the selected workspace (AC3)", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(monorepoRoot);
    const imp = buildRepositoryImport(reader, repo);
    const narrowed = narrowToWorkspace(imp, "packages/core");
    const generator = new HeuristicCandidateGenerator();
    const candidates = await generator.generate({
      reader,
      repo,
      tree: narrowed.tree,
      entryCandidates: narrowed.entryCandidates,
      packageInfo: imp.packageInfo,
      workspacePath: "packages/core",
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      for (const path of candidate.entryFiles) {
        expect(path.startsWith("packages/core/")).toBe(true);
      }
    }
  });

  it("returns a walkthrough candidate when nothing is exportable", async () => {
    const reader = makeReader();
    const dir = mkdtempSync(join(tmpdir(), "repocoach-empty-"));
    tempDirs.push(dir);
    const repo = await reader.importRepository(dir);
    const generator = new HeuristicCandidateGenerator();
    const candidates = await generator.generate({
      reader,
      repo,
      tree: [],
      entryCandidates: [],
      packageInfo: null,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("repository-walkthrough");
    expect(featureCandidateSchema.safeParse(candidates[0]).success).toBe(true);
  });

  it("penetrates multi-layer barrels and points candidates at the real definition", async () => {
    const candidates = await generateFor({
      "package.json": pkg("src/index.ts"),
      "src/index.ts": 'export * from "./v4/external.js";\n',
      "src/v4/external.ts":
        'export * from "./schemas.js";\nexport * from "./parse.js";\n',
      "src/v4/schemas.ts":
        'export function stringSchema(): string { return "z.string()"; }\n',
      "src/v4/parse.ts": "export class Parser { run(): void {} }\n",
    });

    const entryFiles = candidates.flatMap((candidate) => candidate.entryFiles);
    expect(entryFiles).toContain("src/v4/schemas.ts");
    expect(entryFiles).toContain("src/v4/parse.ts");
    // No walkthrough fallback — the barrels led to real definitions.
    expect(candidates.some((candidate) => candidate.id === "repository-walkthrough")).toBe(
      false,
    );
    // Entry files are the defining files, never the barrels themselves.
    expect(entryFiles).not.toContain("src/index.ts");
    expect(entryFiles).not.toContain("src/v4/external.ts");
    // The description notes the entry barrel that re-exported the symbol.
    const schemas = candidates.find((candidate) =>
      candidate.entryFiles.includes("src/v4/schemas.ts"),
    );
    expect(schemas?.description).toContain("exported from src/index.ts");
  });

  it("resolves `.js` re-export specifiers to the `.ts` source on disk", async () => {
    const candidates = await generateFor({
      "package.json": pkg("src/index.ts"),
      "src/index.ts": 'export * from "./core.js";\n',
      "src/core.ts": "export function realThing(): number { return 1; }\n",
    });

    expect(candidates.flatMap((candidate) => candidate.entryFiles)).toContain(
      "src/core.ts",
    );
    expect(candidates.some((candidate) => candidate.id === "repository-walkthrough")).toBe(
      false,
    );
  });

  it("stops at the barrel depth limit and degrades to the walkthrough", async () => {
    // MAX_REEXPORT_DEPTH is 3, so a definition five re-exports deep is
    // deliberately unreachable and the generator must degrade, not recurse.
    const files: Record<string, string> = {
      "package.json": pkg("src/index.ts"),
      "src/index.ts": 'export * from "./l1.js";\n',
    };
    for (let i = 1; i <= 5; i += 1) {
      files[`src/l${i}.ts`] =
        i < 5
          ? `export * from "./l${i + 1}.js";\n`
          : "export function deepTarget(): void {}\n";
    }

    const candidates = await generateFor(files);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("repository-walkthrough");
  });

  it("does not hang on cyclic re-exports and finds the definition in the loop", async () => {
    const candidates = await generateFor({
      "package.json": pkg("src/index.ts"),
      "src/index.ts": 'export * from "./a.js";\n',
      "src/a.ts": 'export * from "./b.js";\n',
      "src/b.ts": 'export * from "./a.js";\nexport function inB(): string { return "b"; }\n',
    });

    expect(candidates.flatMap((candidate) => candidate.entryFiles)).toContain(
      "src/b.ts",
    );
    expect(candidates.some((candidate) => candidate.id === "repository-walkthrough")).toBe(
      false,
    );
  });

  it("rejects a re-export specifier that escapes the repository", async () => {
    const candidates = await generateFor({
      "package.json": pkg("src/index.ts"),
      "src/index.ts": 'export * from "../../../../etc/passwd";\n',
    });

    // The malicious specifier must never be read: no throw, no candidate
    // pointing outside the repo, just the safe walkthrough fallback.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("repository-walkthrough");
    expect(candidates[0]?.entryFiles).toEqual(["src/index.ts"]);
  });

  it("gives distinct ids to the same-named symbol exported from two entry files", async () => {
    const reader = makeReader();
    const dir = mkdtempSync(join(tmpdir(), "repocoach-dup-symbol-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "dup", version: "0.1.0", main: "a.ts", bin: { cli: "b.ts" } }),
      "utf8",
    );
    writeFileSync(join(dir, "a.ts"), 'export function handler() {\n  return "a";\n}\n', "utf8");
    writeFileSync(join(dir, "b.ts"), 'export function handler() {\n  return "b";\n}\n', "utf8");

    const repo = await reader.importRepository(dir);
    const imp = buildRepositoryImport(reader, repo);
    const generator = new HeuristicCandidateGenerator();
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    const ids = candidates.map((candidate) => candidate.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    // Each id is keyed by its entry file, so find() resolves the right one.
    for (const candidate of candidates) {
      const [entryFile] = candidate.entryFiles;
      expect(entryFile).toBeDefined();
      expect(candidate.id).toContain(
        entryFile!.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase(),
      );
      expect(candidates.find((item) => item.id === candidate.id)).toBe(candidate);
    }
  });

  it("appends a sequence when two entry paths slug to the same id", async () => {
    const reader = makeReader();
    const dir = mkdtempSync(join(tmpdir(), "repocoach-slug-clash-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "x"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "clash", version: "0.1.0", main: "x/y.ts", bin: { cli: "x-y.ts" } }),
      "utf8",
    );
    writeFileSync(join(dir, "x", "y.ts"), 'export function handler() {\n  return "x/y";\n}\n', "utf8");
    writeFileSync(join(dir, "x-y.ts"), 'export function handler() {\n  return "x-y";\n}\n', "utf8");

    const repo = await reader.importRepository(dir);
    const imp = buildRepositoryImport(reader, repo);
    const generator = new HeuristicCandidateGenerator();
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    const ids = candidates.map((candidate) => candidate.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    for (const candidate of candidates) {
      expect(candidates.find((item) => item.id === candidate.id)).toBe(candidate);
    }
  });
});

describe("filterCandidatesToTree", () => {
  it("drops candidates from a generator that hallucinated paths (AC4)", async () => {
    const hallucinating: CandidateGenerator = {
      async generate(): Promise<FeatureCandidate[]> {
        return [
          {
            id: "real",
            title: "real",
            description: "d",
            entryFiles: ["src/index.ts"],
            difficulty: "intro",
          },
          {
            id: "ghost",
            title: "ghost",
            description: "d",
            entryFiles: ["src/ghost.ts"],
            difficulty: "intro",
          },
        ];
      },
    };

    const raw = await hallucinating.generate({} as CandidateGeneratorInput);
    const kept = filterCandidatesToTree(raw, [{ path: "src/index.ts", size: 1 }]);

    expect(kept.map((candidate) => candidate.id)).toEqual(["real"]);
  });
});
