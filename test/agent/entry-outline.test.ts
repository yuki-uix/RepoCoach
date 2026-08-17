import { describe, expect, it } from "vitest";
import {
  MAX_ENTRY_OUTLINE_BYTES,
  UNTRUSTED_DATA_END,
  UNTRUSTED_DATA_START,
  buildEntryOutline,
  byteLength,
} from "../../src/agent";
import { makeTempReader } from "./helpers";

describe("buildEntryOutline", () => {
  it("lists top-level exported symbols with line numbers, never implementation", async () => {
    const { reader, repo } = makeTempReader({
      "src/index.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    });

    const outline = await buildEntryOutline(reader, repo, ["src/index.ts"]);

    expect(outline).not.toBeNull();
    expect(outline!.content).toContain("src/index.ts:");
    expect(outline!.content).toContain("add (function, line 1)");
    // The implementation body is never part of the outline.
    expect(outline!.content).not.toContain("return a + b");
  });

  it("wraps the outline in UNTRUSTED_DATA markers", async () => {
    const { reader, repo } = makeTempReader({
      "src/index.ts": "export function add(): void {}\n",
    });

    const outline = await buildEntryOutline(reader, repo, ["src/index.ts"]);

    expect(outline!.content).toContain(UNTRUSTED_DATA_START);
    expect(outline!.content).toContain(UNTRUSTED_DATA_END);
    expect(outline!.content).toContain("kind=entry_outline");
  });

  it("follows a barrel to the defining file, reusing barrel penetration", async () => {
    const { reader, repo } = makeTempReader({
      "src/index.ts": 'export * from "./core.js";\n',
      "src/core.ts":
        "export function realThing(): number { return 1; }\n" +
        "export class Parser { run(): void {} }\n",
    });

    const outline = await buildEntryOutline(reader, repo, ["src/index.ts"]);

    expect(outline!.content).toContain("src/core.ts:");
    expect(outline!.content).toContain("realThing (function, line 1)");
    expect(outline!.content).toContain("Parser (class, line 2)");
  });

  it("caps the wrapped block and notes omitted files when the budget is exceeded", async () => {
    const files: Record<string, string> = {};
    const entryFiles: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const path = `src/file_${String(i).padStart(4, "0")}.ts`;
      entryFiles.push(path);
      files[path] =
        `export function symbol_${i}_alpha(): void {}\n` +
        `export function symbol_${i}_beta(): void {}\n`;
    }
    const { reader, repo } = makeTempReader(files);

    const outline = await buildEntryOutline(reader, repo, entryFiles);

    expect(outline).not.toBeNull();
    expect(byteLength(outline!.content)).toBeLessThanOrEqual(MAX_ENTRY_OUTLINE_BYTES);
    expect(outline!.content).toContain("omitted");
    expect(outline!.fileCount).toBeLessThan(entryFiles.length);
  });

  it("returns null for an empty entry-file list", async () => {
    const { reader, repo } = makeTempReader({ "src/index.ts": "export const x = 1;\n" });

    expect(await buildEntryOutline(reader, repo, [])).toBeNull();
  });

  it("returns null when no entry file resolves to an exported symbol", async () => {
    const { reader, repo } = makeTempReader({ "src/index.ts": "const internal = 1;\n" });

    expect(await buildEntryOutline(reader, repo, ["src/index.ts"])).toBeNull();
  });
});
