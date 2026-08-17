import { describe, expect, it } from "vitest";
import { parseArgs, runCli } from "../../src/cli";
import { capturedStreams, makeDataDir } from "./helpers";

describe("parseArgs", () => {
  it("parses each of the three override flags", () => {
    expect(parseArgs(["start", "./repo", "--max-turns", "3"])).toEqual({
      command: "start",
      arg: "./repo",
      maxTurns: "3",
    });
    expect(
      parseArgs(["start", "./repo", "--max-input-tokens", "2000000"]),
    ).toMatchObject({ maxInputTokens: "2000000" });
    expect(
      parseArgs(["start", "./repo", "--max-output-tokens", "70000"]),
    ).toMatchObject({ maxOutputTokens: "70000" });
  });

  it("does not mistake a flag value for the positional argument", () => {
    expect(parseArgs(["start", "./repo", "--max-turns", "3"]).arg).toBe("./repo");
    expect(parseArgs(["start", "--max-turns", "3", "./repo"]).arg).toBe("./repo");
    expect(parseArgs(["start", "./repo", "--max-input-tokens", "5"]).arg).toBe("./repo");
    expect(parseArgs(["start", "./repo", "--data-dir", "/tmp"]).arg).toBe("./repo");
  });

  it("still parses --data-dir alongside the new flags", () => {
    expect(parseArgs(["list", "--data-dir", "/tmp"])).toEqual({
      command: "list",
      dataDir: "/tmp",
    });
    expect(
      parseArgs(["start", "./repo", "--data-dir", "/tmp", "--max-turns", "3"]),
    ).toMatchObject({ command: "start", arg: "./repo", dataDir: "/tmp", maxTurns: "3" });
  });

  it("records a flag without a value as an empty string", () => {
    expect(parseArgs(["start", "./repo", "--max-turns"]).maxTurns).toBe("");
  });
});

describe("runCli override validation", () => {
  it.each([
    [["--max-turns", "0"], "max-turns"],
    [["--max-turns", "-1"], "max-turns"],
    [["--max-turns", "abc"], "max-turns"],
    [["--max-turns"], "max-turns"],
    [["--max-input-tokens", "0"], "max-input-tokens"],
    [["--max-input-tokens", "3.5"], "max-input-tokens"],
    [["--max-output-tokens", "abc"], "max-output-tokens"],
    [["--max-output-tokens"], "max-output-tokens"],
  ])("rejects %j with a usage error", async (extra, flag) => {
    const streams = capturedStreams();
    const code = await runCli(["start", "./repo", ...extra], {
      dataDir: makeDataDir(),
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(1);
    const err = streams.stderrText();
    expect(err).toContain(`--${flag}`);
    expect(err).toContain("Usage:");
  });
});
