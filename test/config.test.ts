import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create a temp dir and, optionally, a `.env.local` file inside it.
 * Returns the path to that `.env.local` (which may not exist when `content`
 * is omitted). Tests never touch the real `.env.local`.
 */
function makeEnvFile(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repocoach-config-"));
  tempDirs.push(dir);
  const filePath = join(dir, ".env.local");
  if (content !== undefined) {
    writeFileSync(filePath, content, "utf8");
  }
  return filePath;
}

describe("loadConfig", () => {
  it("reads Deepseek_key from a .env.local file", () => {
    const filePath = makeEnvFile("Deepseek_key=sk-test-123\n");
    expect(loadConfig(filePath).deepseekKey).toBe("sk-test-123");
  });

  it("ignores comments and unrelated keys", () => {
    const filePath = makeEnvFile(
      "# a comment\nOTHER_KEY=value\n\nDeepseek_key=sk-abc\n",
    );
    expect(loadConfig(filePath).deepseekKey).toBe("sk-abc");
  });

  it("handles CRLF line endings and surrounding whitespace", () => {
    const filePath = makeEnvFile("Deepseek_key = sk-crlf\r\n");
    expect(loadConfig(filePath).deepseekKey).toBe("sk-crlf");
  });

  it("throws when the env file is missing", () => {
    const filePath = makeEnvFile();
    expect(() => loadConfig(filePath)).toThrow(/Could not read env file/);
  });

  it("throws when Deepseek_key is absent", () => {
    const filePath = makeEnvFile("OTHER_KEY=value\n");
    expect(() => loadConfig(filePath)).toThrow(/Missing or empty Deepseek_key/);
  });

  it("throws when Deepseek_key is empty", () => {
    const filePath = makeEnvFile("Deepseek_key=\n");
    expect(() => loadConfig(filePath)).toThrow(/Missing or empty Deepseek_key/);
  });

  it("never includes arbitrary file contents in error messages", () => {
    const secret = "sk-super-secret-value";
    const filePath = makeEnvFile(`OTHER_KEY=${secret}\n`);
    let message = "";
    try {
      loadConfig(filePath);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Missing or empty Deepseek_key/);
    expect(message).not.toContain(secret);
  });
});
