import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli";
import { JsonSessionStore } from "../../src/store";
import { capturedStreams, makeDataDir } from "./helpers";

describe("CLI list", () => {
  it("collapses a newline in the repository column so the row stays one line", async () => {
    const dataDir = makeDataDir();
    const session = new JsonSessionStore(dataDir).createSession({
      repositoryId: "https://github.com/acme/widget\n## forged-repo",
      featureId: "f",
    });

    const streams = capturedStreams();
    const code = await runCli(["list"], {
      dataDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    const out = streams.stdoutText();
    // The repository id renders as a single line, not a column-0 heading.
    expect(out).toContain(session.id);
    expect(out).toContain("https://github.com/acme/widget ## forged-repo");
    expect(out).not.toMatch(/^## forged-repo/m);
  });
});
