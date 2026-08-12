import { readFileSync } from "node:fs";
import { join } from "node:path";

const KEY_NAME = "Deepseek_key";

export interface Config {
  /** API key for the DeepSeek provider. Never log this value. */
  deepseekKey: string;
}

/**
 * Load runtime config from a `.env.local` file.
 *
 * By default the file is read from the repo root (the current working
 * directory). Pass an explicit path (e.g. in tests) to read from elsewhere.
 * The API key value is never interpolated into any thrown error message.
 */
export function loadConfig(
  envFilePath: string = join(process.cwd(), ".env.local"),
): Config {
  const raw = readEnvFile(envFilePath);
  const deepseekKey = parseDeepseekKey(raw);
  if (deepseekKey === undefined) {
    throw new Error(
      `Missing or empty ${KEY_NAME} in ${envFilePath}. ` +
        `Expected a line: ${KEY_NAME}=<value>`,
    );
  }
  return { deepseekKey };
}

function readEnvFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new Error(
      `Could not read env file at ${filePath}. ` +
        `Create it with a line: ${KEY_NAME}=<value>`,
    );
  }
}

function parseDeepseekKey(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (key !== KEY_NAME) {
      continue;
    }
    const value = trimmed.slice(separator + 1).trim();
    if (value === "") {
      return undefined;
    }
    return value;
  }
  return undefined;
}
