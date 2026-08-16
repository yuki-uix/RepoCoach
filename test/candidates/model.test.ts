import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPO_DATA_END,
  REPO_DATA_START,
  type ChatCompletionRequest,
  type ChatProvider,
} from "../../src/agent";
import { ModelCandidateGenerator } from "../../src/candidates/model";
import { featureCandidateSchema, type FeatureCandidate } from "../../src/domain";
import { buildRepositoryImport } from "../../src/import";
import { createReader, type Reader } from "../../src/reader";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "fixtures", "fixture-repo");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeReader(): Reader {
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-model-"));
  tempDirs.push(cacheRoot);
  return createReader({ cacheRoot });
}

function pkg(main: string): string {
  return JSON.stringify({ name: "barrel", version: "0.1.0", main });
}

/** Write a repo file map (rel path → content) into a fresh temp directory. */
function writeRepoFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

/** Import a temp repo described by `files` and run the model generator over it. */
async function generateForFiles(
  files: Record<string, string>,
  contents: Array<string | null>,
): Promise<{ requests: ChatCompletionRequest[]; candidates: FeatureCandidate[] }> {
  const reader = makeReader();
  const dir = mkdtempSync(join(tmpdir(), "repocoach-model-tmp-"));
  tempDirs.push(dir);
  writeRepoFiles(dir, files);
  const repo = await reader.importRepository(dir);
  const imp = buildRepositoryImport(reader, repo);

  const { provider, requests } = recordingProvider(contents);
  const generator = new ModelCandidateGenerator({ provider });
  const candidates = await generator.generate({
    reader,
    repo,
    tree: imp.tree,
    entryCandidates: imp.entryCandidates,
    packageInfo: imp.packageInfo,
  });
  return { requests, candidates };
}

/** A repo whose entry barrel re-exports five distinct real symbols. */
const BARREL_FILES: Record<string, string> = {
  "package.json": pkg("src/index.ts"),
  "src/index.ts":
    'export * from "./a.js";\n' +
    'export * from "./b.js";\n' +
    'export * from "./c.js";\n' +
    'export * from "./d.js";\n' +
    'export * from "./e.js";\n',
  "src/a.ts": "export function alpha(): number { return 1; }\n",
  "src/b.ts": "export function beta(): number { return 2; }\n",
  "src/c.ts": "export function gamma(): number { return 3; }\n",
  "src/d.ts": "export function delta(): number { return 4; }\n",
  "src/e.ts": "export function epsilon(): number { return 5; }\n",
};

/** A provider that replays `contents` and records every request it received. */
function recordingProvider(
  contents: Array<string | null>,
): { provider: ChatProvider; requests: ChatCompletionRequest[] } {
  const requests: ChatCompletionRequest[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      async complete(request) {
        requests.push(request);
        const content = contents[Math.min(index, contents.length - 1)] ?? null;
        index += 1;
        return {
          message: { role: "assistant", content },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  };
}

describe("ModelCandidateGenerator", () => {
  it("retries once then falls back to the heuristic on invalid output", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const { provider, requests } = recordingProvider(["not json", "still not json"]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    // One attempt + one retry before the heuristic fallback.
    expect(requests).toHaveLength(2);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(featureCandidateSchema.safeParse(candidate).success).toBe(true);
    }
    // The heuristic fallback names a real entry file from the fixture.
    expect(candidates.some((c) => c.entryFiles.includes("src/index.ts"))).toBe(
      true,
    );
  });

  it("wraps repo data and keeps it out of the system prompt", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const valid = JSON.stringify([
      {
        id: "m1",
        title: "Model candidate",
        description: "d",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
    ]);
    const { provider, requests } = recordingProvider([valid]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe("m1");
    expect(requests).toHaveLength(1);

    const messages = requests[0]!.messages;
    const system = messages.find((message) => message.role === "system");
    const user = messages.find((message) => message.role === "user");

    // Repository data never reaches the system prompt.
    expect(system?.content ?? "").not.toContain("src/index.ts");
    expect(system?.content ?? "").not.toContain("createTracker");
    // Repository data is wrapped in REPO_DATA markers in the user message.
    expect(user?.content ?? "").toContain(REPO_DATA_START);
    expect(user?.content ?? "").toContain(REPO_DATA_END);
    expect(user?.content ?? "").toContain("src/index.ts");
  });

  it("feeds barrel-penetrated real symbols into the model input", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const valid = JSON.stringify([
      {
        id: "m1",
        title: "Model candidate",
        description: "d",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
    ]);
    const { provider, requests } = recordingProvider([valid]);
    const generator = new ModelCandidateGenerator({ provider });
    await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    const user = requests[0]!.messages.find((message) => message.role === "user");
    // The model is handed the barrel-penetrated definitions, not just the raw
    // file list, so it can pick among real symbols.
    expect(user?.content ?? "").toContain("Resolved symbols");
    expect(user?.content ?? "").toContain("file=src/index.ts");
    expect(user?.content ?? "").toContain("symbol=createTracker");
  });

  it("disambiguates duplicate titles from the model", async () => {
    const dupes = JSON.stringify([
      {
        id: "t1",
        title: "Trace the number call chain",
        description: "Follow alpha.",
        entryFiles: ["src/a.ts"],
        difficulty: "intro",
      },
      {
        id: "t2",
        title: "Trace the number call chain",
        description: "Follow beta.",
        entryFiles: ["src/b.ts"],
        difficulty: "intro",
      },
    ]);
    const { requests, candidates } = await generateForFiles(BARREL_FILES, [dupes]);

    expect(requests).toHaveLength(1);
    expect(candidates).toHaveLength(2);
    const titles = candidates.map((candidate) => candidate.title);
    expect(new Set(titles).size).toBe(titles.length);
    // The duplicate carries its defining file so the two choices are tellable.
    expect(titles.some((title) => title.includes("src/b.ts"))).toBe(true);
  });

  it("disambiguates duplicate ids from the model", async () => {
    const dupes = JSON.stringify([
      {
        id: "dup",
        title: "First",
        description: "Follow alpha.",
        entryFiles: ["src/a.ts"],
        difficulty: "intro",
      },
      {
        id: "dup",
        title: "Second",
        description: "Follow beta.",
        entryFiles: ["src/b.ts"],
        difficulty: "intro",
      },
    ]);
    const { requests, candidates } = await generateForFiles(BARREL_FILES, [dupes]);

    expect(requests).toHaveLength(1);
    expect(candidates).toHaveLength(2);
    const ids = candidates.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The first keeps its id; the duplicate is suffixed, so a later
    // find(id) never resolves to the wrong candidate.
    expect(ids[0]).toBe("dup");
    expect(ids[1]).not.toBe("dup");
  });

  it("rejects change-proposal candidates and falls back to the heuristic", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const changeProposals = JSON.stringify([
      {
        id: "n1",
        title: "Add a base32 string format validator",
        description: "Add a base32 string format that validates RFC 4648 input.",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
      {
        id: "n2",
        title: "Implement a semver validator",
        description: "Implement semver checking so users can validate versions.",
        entryFiles: ["src/parse/validate.ts"],
        difficulty: "intermediate",
      },
      {
        id: "n3",
        title: "Refactor the store to use a Map",
        description: "Refactor MemoryStore internals to back the store with a Map.",
        entryFiles: ["src/store/memory.ts"],
        difficulty: "advanced",
      },
    ]);
    const { provider, requests } = recordingProvider([changeProposals]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    // Both the attempt and the retry are rejected, so generation falls back.
    expect(requests).toHaveLength(2);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(featureCandidateSchema.safeParse(candidate).success).toBe(true);
    }
    // The fallback is the heuristic, which traces existing chains — never a
    // "Add X / Implement X" change proposal.
    expect(
      candidates.some(
        (c) =>
          c.id === "repository-walkthrough" ||
          c.title.startsWith("Trace") ||
          c.title.startsWith("Understand"),
      ),
    ).toBe(true);
    expect(
      candidates.every((c) => !/^(?:add|implement|create|refactor|fix)\b/i.test(c.title)),
    ).toBe(true);
  });

  it("drops change proposals but keeps real trace candidates", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const mixed = JSON.stringify([
      {
        id: "n1",
        title: "Add a base32 string format validator",
        description: "Add a base32 string format that validates RFC 4648 input.",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
      {
        // Title looks like a trace, but the description asks for a change.
        id: "n2",
        title: "Trace the validate function",
        description: "A semver format should be added to validate version strings.",
        entryFiles: ["src/parse/validate.ts"],
        difficulty: "intermediate",
      },
      {
        id: "t1",
        title: "Trace the createTracker call chain",
        description:
          "Follow createTracker as it wires parse, validate, store and render.",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
    ]);
    const { provider, requests } = recordingProvider([mixed]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    // Only the genuine trace candidate survives; no retry is needed because at
    // least one usable candidate remained.
    expect(requests).toHaveLength(1);
    expect(candidates.map((c) => c.id)).toEqual(["t1"]);
  });

  it("caps the model output at 3 candidates", async () => {
    const five = JSON.stringify([
      {
        id: "t1",
        title: "Trace alpha",
        description: "Follow alpha.",
        entryFiles: ["src/a.ts"],
        difficulty: "intro",
      },
      {
        id: "t2",
        title: "Trace beta",
        description: "Follow beta.",
        entryFiles: ["src/b.ts"],
        difficulty: "intro",
      },
      {
        id: "t3",
        title: "Trace gamma",
        description: "Follow gamma.",
        entryFiles: ["src/c.ts"],
        difficulty: "intermediate",
      },
      {
        id: "t4",
        title: "Trace delta",
        description: "Follow delta.",
        entryFiles: ["src/d.ts"],
        difficulty: "intermediate",
      },
      {
        id: "t5",
        title: "Trace epsilon",
        description: "Follow epsilon.",
        entryFiles: ["src/e.ts"],
        difficulty: "advanced",
      },
    ]);
    const { requests, candidates } = await generateForFiles(BARREL_FILES, [five]);

    expect(requests).toHaveLength(1);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("drops a candidate whose entry file is a real doc but not a resolved definition", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const bogus = JSON.stringify([
      {
        id: "m1",
        title: "Trace the invented thing",
        description: "Trace inventedThing as it transforms the input.",
        entryFiles: ["README.md"],
        difficulty: "intro",
      },
    ]);
    const { provider, requests } = recordingProvider([bogus]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    // README.md is in the tree (so `filterCandidatesToTree` keeps it) but is
    // neither an entry candidate nor a barrel-penetrated definition, and
    // `inventedThing` names no real symbol — so the candidate is dropped and
    // generation retries once, then falls back to the heuristic.
    expect(requests).toHaveLength(2);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.id !== "m1")).toBe(true);
  });

  it("keeps a candidate whose entry file and named symbol are real", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const valid = JSON.stringify([
      {
        id: "m1",
        title: "Trace the createTracker call chain",
        description:
          "Follow createTracker as it wires parse, validate, store and render.",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
    ]);
    const { provider, requests } = recordingProvider([valid]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    expect(requests).toHaveLength(1);
    expect(candidates.map((c) => c.id)).toEqual(["m1"]);
  });

  it("falls back to the heuristic when every model candidate names fabricated symbols", async () => {
    const reader = makeReader();
    const repo = await reader.importRepository(fixtureRoot);
    const imp = buildRepositoryImport(reader, repo);

    const fabricated = JSON.stringify([
      {
        id: "f1",
        title: "Trace inventedThing",
        description: "Trace inventedThing as it runs.",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
      {
        id: "f2",
        title: "Trace anotherInvention",
        description: "Trace anotherInvention as it runs.",
        entryFiles: ["src/index.ts"],
        difficulty: "intro",
      },
    ]);
    const { provider, requests } = recordingProvider([fabricated]);
    const generator = new ModelCandidateGenerator({ provider });
    const candidates = await generator.generate({
      reader,
      repo,
      tree: imp.tree,
      entryCandidates: imp.entryCandidates,
      packageInfo: imp.packageInfo,
    });

    // Both names are code-shaped but undefined in the repository, so every
    // model candidate is dropped and generation falls back to the heuristic.
    expect(requests).toHaveLength(2);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(featureCandidateSchema.safeParse(candidate).success).toBe(true);
    }
  });

  it("drops a candidate whose title names a fabricated symbol despite a benign description", async () => {
    const mixed = JSON.stringify([
      {
        // The fabricated symbol lives only in the title; the description is
        // plain prose with no code-shaped token, so grounding must still see it.
        id: "bad",
        title: "Trace inventedThing",
        description: "Understand how the entry point wires the pipeline together.",
        entryFiles: ["src/a.ts"],
        difficulty: "intro",
      },
      {
        id: "good",
        title: "Trace alpha",
        description: "Follow alpha through beta.",
        entryFiles: ["src/b.ts"],
        difficulty: "intro",
      },
    ]);
    const { requests, candidates } = await generateForFiles(BARREL_FILES, [mixed]);

    expect(requests).toHaveLength(1);
    expect(candidates.map((c) => c.id)).toEqual(["good"]);
  });

  it("keeps a candidate whose title and description name only real symbols", async () => {
    const valid = JSON.stringify([
      {
        id: "m1",
        title: "Trace alpha",
        description: "Follow alpha as it returns the count through beta.",
        entryFiles: ["src/a.ts"],
        difficulty: "intro",
      },
    ]);
    const { requests, candidates } = await generateForFiles(BARREL_FILES, [valid]);

    expect(requests).toHaveLength(1);
    expect(candidates.map((c) => c.id)).toEqual(["m1"]);
  });

  it("keeps a candidate whose title carries an all-caps prose word", async () => {
    const valid = JSON.stringify([
      {
        // "PARSE" is prose emphasis, not a symbol: the conservative extractor
        // (issue #27) must not turn it into an ungrounded identifier.
        id: "m1",
        title: "Trace the PARSE pipeline",
        description: "Understand how the entry point routes input.",
        entryFiles: ["src/a.ts"],
        difficulty: "intro",
      },
    ]);
    const { requests, candidates } = await generateForFiles(BARREL_FILES, [valid]);

    expect(requests).toHaveLength(1);
    expect(candidates.map((c) => c.id)).toEqual(["m1"]);
  });

  it("falls back to the heuristic when every candidate's title names a fabricated symbol", async () => {
    const fabricated = JSON.stringify([
      {
        id: "f1",
        title: "Trace inventedThing",
        description: "Understand how the entry point wires the pipeline.",
        entryFiles: ["src/a.ts"],
        difficulty: "intro",
      },
      {
        id: "f2",
        title: "Trace anotherInvention",
        description: "Understand how the entry point wires the pipeline.",
        entryFiles: ["src/b.ts"],
        difficulty: "intro",
      },
    ]);
    const { requests, candidates } = await generateForFiles(BARREL_FILES, [fabricated]);

    // Both titles are code-shaped but undefined, so every model candidate is
    // dropped and generation falls back to the heuristic (which still yields
    // candidates tracing the real exported symbols).
    expect(requests).toHaveLength(2);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.id !== "f1" && c.id !== "f2")).toBe(true);
  });
});
