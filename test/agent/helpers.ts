/**
 * Test helpers for the agent module: build a Reader over an in-memory temp
 * directory (no git, no network) plus small SSE utilities for mock providers.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReader, type Reader, type Repository } from "../../src/reader";

export interface TempRepoDir {
  dir: string;
  reader: Reader;
  repo: Repository;
}

/** Create a reader bound to a temp dir seeded with the given files. */
export function makeTempReader(files: Record<string, string>): TempRepoDir {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-agent-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  const cacheRoot = mkdtempSync(join(tmpdir(), "repocoach-cache-"));
  const reader = createReader({ cacheRoot });
  const repo: Repository = {
    source: { kind: "local", path: dir },
    rootDir: dir,
    sha: "test",
    meta: null,
  };
  return { dir, reader, repo };
}

/** Build an SSE Response from a text body, optionally split into byte chunks. */
export function sseResponse(text: string, chunkSize?: number): Response {
  const encoder = new TextEncoder();
  const pieces =
    chunkSize === undefined
      ? [text]
      : Array.from({ length: Math.ceil(text.length / chunkSize) }, (_, i) =>
          text.slice(i * chunkSize, (i + 1) * chunkSize),
        );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Build one SSE `data:` line from any JSON-serialisable object. */
export function sseLine(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
