import { describe, expect, it } from "vitest";
import { parseRepoUrl } from "../../src/reader/url";

describe("parseRepoUrl", () => {
  it("parses a full GitHub URL", () => {
    expect(parseRepoUrl("https://github.com/owner/name")).toEqual({
      kind: "github",
      owner: "owner",
      name: "name",
    });
  });

  it("parses a GitHub URL with a /tree/ branch ref", () => {
    expect(parseRepoUrl("https://github.com/owner/name/tree/main")).toEqual({
      kind: "github",
      owner: "owner",
      name: "name",
      ref: "main",
    });
  });

  it("parses a slashed branch name", () => {
    expect(
      parseRepoUrl("https://github.com/owner/name/tree/feature/foo"),
    ).toEqual({
      kind: "github",
      owner: "owner",
      name: "name",
      ref: "feature/foo",
    });
  });

  it("accepts scheme-less and www forms", () => {
    expect(parseRepoUrl("github.com/owner/name")).toEqual({
      kind: "github",
      owner: "owner",
      name: "name",
    });
    expect(parseRepoUrl("www.github.com/owner/name/tree/dev")).toEqual({
      kind: "github",
      owner: "owner",
      name: "name",
      ref: "dev",
    });
  });

  it("parses the owner/name shorthand", () => {
    expect(parseRepoUrl("owner/name")).toEqual({
      kind: "github",
      owner: "owner",
      name: "name",
    });
  });

  it("parses a file:// URL into a local path", () => {
    expect(parseRepoUrl("file:///tmp/some-repo").kind).toBe("local");
  });

  it("treats absolute paths as local", () => {
    const result = parseRepoUrl("/tmp/some-repo");
    expect(result.kind).toBe("local");
    if (result.kind === "local") {
      expect(result.path).toBe("/tmp/some-repo");
    }
  });

  it("treats explicitly-relative paths as local", () => {
    expect(parseRepoUrl("./relative/repo").kind).toBe("local");
    expect(parseRepoUrl("../parent/repo").kind).toBe("local");
  });

  it("treats multi-segment paths as local", () => {
    expect(parseRepoUrl("path/to/repo").kind).toBe("local");
  });

  it("rejects empty input", () => {
    expect(() => parseRepoUrl("")).toThrow(/empty/);
    expect(() => parseRepoUrl("   ")).toThrow(/empty/);
  });

  it("rejects a malformed GitHub URL", () => {
    expect(() => parseRepoUrl("https://github.com/owner")).toThrow(
      /Invalid GitHub repository URL/,
    );
  });

  it("rejects an invalid owner name", () => {
    expect(() => parseRepoUrl("https://github.com/bad_owner/name")).toThrow(
      /Invalid GitHub owner/,
    );
  });

  it("rejects an invalid repository name", () => {
    expect(() => parseRepoUrl("https://github.com/owner/bad!name")).toThrow(
      /Invalid GitHub repository name/,
    );
  });
});
