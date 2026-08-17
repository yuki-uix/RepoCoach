/**
 * Architecture fitness tests (issue #31, mechanism 3).
 *
 * The security review keeps re-finding the same gate-bypass shape ("which exits
 * belong to this gate" was eyeballed for five rounds). The mechanically
 * judge-able half of that review is which *modules* are allowed to do a
 * dangerous thing, so it is written here as an explicit whitelist and the test
 * walks every `.ts` file under `src/` asserting nothing outside the whitelist
 * does it. A new file that imports `node:fs`, spawns a subprocess, or constructs
 * a data-guard marker fails the suite immediately — forcing a deliberate,
 * documented decision instead of a later re-review. docs/architecture.md §6.
 *
 * Each whitelist entry carries a written reason: the comment is the point of the
 * test, and an entry without a reason is a bug (asserted below, not just asked
 * for politely). The three rules:
 *
 *  A. file-system access — repository content may only be read through the
 *     reader's fs-guard; every other `node:fs` import reads something that is
 *     NOT repository content (.env.local, session files, fixtures, eval I/O).
 *  B. subprocess — only the reader's clone and search may spawn; both use
 *     `execFile` with a fixed argv and never `shell: true`.
 *  C. marker construction — the REPO_DATA / UNTRUSTED_DATA boundary markers are
 *     defined in data-guard.ts alone, because wrap/escape logic must not fork.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REPO_DATA_END,
  REPO_DATA_START,
  UNTRUSTED_DATA_END,
  UNTRUSTED_DATA_START,
} from "../../src/agent";

/** A scanned source file: project-relative path (POSIX) plus its text. */
interface SourceFile {
  rel: string;
  content: string;
}

/** One whitelist entry: a path prefix (trailing `/`) or an exact file, plus why. */
interface WhitelistEntry {
  /** `src/`-prefixed path; a trailing `/` means "everything under this dir". */
  path: string;
  /** Why this module is allowed to break the rule. Non-empty, asserted. */
  why: string;
}

/** The action hint every violation carries, so a failing test tells you the fix. */
const HINT = "若确属合法用途，请把它加进本文件的白名单并写明理由";

/** Root of the project, and the `src/` directory the scan walks. */
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const srcDir = join(projectRoot, "src");

/**
 * Recursively read every `.ts` file under `src/`, as (project-relative POSIX
 * path, content) pairs. The scan is plain `node:fs` — no third-party glob.
 */
function readSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push({
          rel: relative(projectRoot, full).split(sep).join("/"),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(srcDir);
  return files;
}

/** True when `rel` is covered by a whitelist entry (prefix for dirs, else exact). */
function isAllowed(rel: string, entries: readonly WhitelistEntry[]): boolean {
  return entries.some((entry) =>
    entry.path.endsWith("/") ? rel.startsWith(entry.path) : rel === entry.path,
  );
}

/** 1-based line number and line text at a character offset. */
function lineAt(content: string, index: number): { number: number; text: string } {
  const upTo = content.slice(0, index);
  const number = upTo.split("\n").length;
  const lineStart = upTo.lastIndexOf("\n") + 1;
  let lineEnd = content.indexOf("\n", index);
  if (lineEnd === -1) {
    lineEnd = content.length;
  }
  return { number, text: content.slice(lineStart, lineEnd) };
}

/**
 * Remove `//` and `/* *\/` comments so a marker / module specifier that appears
 * only in a prose comment (e.g. read-cache.ts documenting `<<<REPO_DATA_END>>>`)
 * is not flagged as a construction. Heuristic, not a lexer: a `//` inside a
 * string literal would also be stripped, but the literals these rules look for
 * never contain `//`, so a real construction can never be masked by it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const files = readSourceFiles();

/* ------------------------------------------------------------------ */
/* Rule A — file-system access                                         */
/* ------------------------------------------------------------------ */

const FS_ACCESS_ALLOWED: WhitelistEntry[] = [
  {
    path: "src/reader/",
    why: "The reader is the single read channel for repository content; every file access here already passes the fs-guard + filters dual gate (§6). It is the fs-guard itself, so it must touch node:fs.",
  },
  {
    path: "src/config.ts",
    why: "Reads .env.local to load the API key — runtime config, not repository content, so it never crosses the repo-data boundary.",
  },
  {
    path: "src/store/json-store.ts",
    why: "Reads/writes session JSON files under the local data dir — local persistence, not repository content.",
  },
  {
    path: "src/cli/candidates.ts",
    why: "Reads the pre-authored fixture candidate list (fixtures/expectations/*.json) — RepoCoach's own test data, not repository content.",
  },
  {
    path: "src/eval/",
    why: "The eval harness reads expected answers and writes reports — its own I/O, never repository content.",
  },
];

/** A module specifier `"node:fs"` / `"node:fs/promises"` in any import form. */
const FS_SPECIFIER_RE = /["']node:fs(?:\/promises)?["']/g;

function fsAccessViolations(scanned: SourceFile[] = files): string[] {
  const violations: string[] = [];
  for (const file of scanned) {
    if (isAllowed(file.rel, FS_ACCESS_ALLOWED)) {
      continue;
    }
    for (const match of file.content.matchAll(FS_SPECIFIER_RE)) {
      const line = lineAt(file.content, match.index);
      violations.push(
        `${file.rel}:${line.number} imports ${match[0]} (rule A) — ${HINT}`,
      );
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* Rule B — subprocess                                                 */
/* ------------------------------------------------------------------ */

const SUBPROCESS_ALLOWED: WhitelistEntry[] = [
  {
    path: "src/reader/clone.ts",
    why: "Spawns `git` via execFile with a fixed argv (never shell:true) to clone/checkout — the reader's only remote-fetch subprocess.",
  },
  {
    path: "src/reader/search.ts",
    why: "Spawns the bundled ripgrep via execFile with a fixed argv (never shell:true) — local search only.",
  },
];

const CHILD_PROCESS_SPECIFIER_RE = /["']node:child_process["']/g;

function subprocessViolations(scanned: SourceFile[] = files): string[] {
  const violations: string[] = [];
  for (const file of scanned) {
    if (isAllowed(file.rel, SUBPROCESS_ALLOWED)) {
      continue;
    }
    for (const match of file.content.matchAll(CHILD_PROCESS_SPECIFIER_RE)) {
      const line = lineAt(file.content, match.index);
      violations.push(
        `${file.rel}:${line.number} imports ${match[0]} (rule B) — ${HINT}`,
      );
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* Rule C — data-guard marker construction                             */
/* ------------------------------------------------------------------ */

const MARKER_ALLOWED: WhitelistEntry[] = [
  {
    path: "src/agent/data-guard.ts",
    why: "Defines the four boundary markers and their escaped stand-ins — the single place the wrap/escape logic lives. Every other module must import the constants, never re-type the literals.",
  },
];

/**
 * The four boundary literals, read from the real constants (not re-typed) so a
 * future marker rename keeps this rule in lock-step. The START values are also
 * the prefix of their `(escaped)` stand-ins, so a file that constructs an
 * escaped stand-in literal is flagged too — it is the same forking risk.
 */
const BOUNDARY_MARKERS = [
  REPO_DATA_START,
  REPO_DATA_END,
  UNTRUSTED_DATA_START,
  UNTRUSTED_DATA_END,
];

function markerViolations(scanned: SourceFile[] = files): string[] {
  const violations: string[] = [];
  for (const file of scanned) {
    if (isAllowed(file.rel, MARKER_ALLOWED)) {
      continue;
    }
    const stripped = stripComments(file.content);
    for (const marker of BOUNDARY_MARKERS) {
      let index = stripped.indexOf(marker);
      while (index !== -1) {
        const line = lineAt(stripped, index);
        violations.push(
          `${file.rel}:${line.number} constructs the data-guard marker ${JSON.stringify(marker)} (rule C) — ${HINT}`,
        );
        index = stripped.indexOf(marker, index + marker.length);
      }
    }
  }
  return violations;
}

describe("architecture fitness (whitelist for dangerous operations)", () => {
  it("scans every source file (self-check for path resolution)", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.rel === "src/agent/data-guard.ts")).toBe(true);
  });

  it("every whitelist entry carries a written reason", () => {
    for (const [name, entries] of [
      ["fs-access", FS_ACCESS_ALLOWED],
      ["subprocess", SUBPROCESS_ALLOWED],
      ["marker", MARKER_ALLOWED],
    ] as const) {
      for (const entry of entries) {
        expect(entry.why.trim(), `${name} whitelist "${entry.path}"`).not.toBe("");
      }
    }
  });

  it("no file outside the whitelist imports node:fs / node:fs/promises", () => {
    expect(fsAccessViolations()).toEqual([]);
  });

  it("no file outside the whitelist imports node:child_process", () => {
    expect(subprocessViolations()).toEqual([]);
  });

  it("no file outside data-guard.ts constructs a data-guard marker literal", () => {
    expect(markerViolations()).toEqual([]);
  });

  // Without this, all three rules above would keep passing if the scanner, the
  // whitelist matcher or a regex silently stopped matching anything — a green
  // suite that checks nothing is the worst outcome for a fitness test.
  it("each rule actually fires on a synthetic violation", () => {
    const offender = (content: string): SourceFile[] => [
      { rel: "src/agent/newcomer.ts", content },
    ];

    const fs = fsAccessViolations(offender('import { readFileSync } from "node:fs";\n'));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toContain("src/agent/newcomer.ts:1");
    expect(fs[0]).toContain(HINT);

    expect(
      subprocessViolations(offender('import { execFile } from "node:child_process";\n')),
    ).toHaveLength(1);

    expect(markerViolations(offender(`const forged = "${REPO_DATA_START}";\n`))).toHaveLength(1);

    // And a whitelisted module with the same content is not flagged.
    expect(
      fsAccessViolations([
        { rel: "src/reader/newcomer.ts", content: 'import { readFileSync } from "node:fs";\n' },
      ]),
    ).toEqual([]);
  });

  // The comment stripper must not mask a real construction, only prose.
  it("ignores a marker mentioned in a comment but not one in code", () => {
    expect(
      markerViolations([
        { rel: "src/agent/doc.ts", content: `// mentions ${REPO_DATA_START} in prose\n` },
      ]),
    ).toEqual([]);
  });
});
