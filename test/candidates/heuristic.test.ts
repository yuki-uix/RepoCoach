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
