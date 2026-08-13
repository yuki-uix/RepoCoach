import { describe, expect, it } from "vitest";
import {
  hasTextExtension,
  isBinaryContent,
  isIncludedInTree,
  isPathExcluded,
  isWithinSizeLimit,
} from "../../src/reader/filters";

describe("isPathExcluded", () => {
  it("excludes dependency and build directories at any depth", () => {
    expect(isPathExcluded("node_modules/foo.js")).toBe(true);
    expect(isPathExcluded("src/dist/x.js")).toBe(true);
    expect(isPathExcluded(".git/HEAD")).toBe(true);
    expect(isPathExcluded("a/b/build/c.js")).toBe(true);
  });

  it("excludes minified bundles", () => {
    expect(isPathExcluded("lib/app.min.js")).toBe(true);
  });

  it("excludes secret files", () => {
    expect(isPathExcluded(".env")).toBe(true);
    expect(isPathExcluded(".env.local")).toBe(true);
    expect(isPathExcluded("server.pem")).toBe(true);
    expect(isPathExcluded("id_rsa")).toBe(true);
    expect(isPathExcluded("id_rsa.pub")).toBe(true);
  });

  it("keeps ordinary source files", () => {
    expect(isPathExcluded("src/app.ts")).toBe(false);
    expect(isPathExcluded("README.md")).toBe(false);
  });
});

describe("hasTextExtension", () => {
  it("accepts text extensions", () => {
    expect(hasTextExtension("a.ts")).toBe(true);
    expect(hasTextExtension("a.jsx")).toBe(true);
    expect(hasTextExtension("package.json")).toBe(true);
    expect(hasTextExtension("README.md")).toBe(true);
  });

  it("accepts known extensionless text files", () => {
    expect(hasTextExtension("Makefile")).toBe(true);
    expect(hasTextExtension("Dockerfile")).toBe(true);
  });

  it("rejects binary extensions", () => {
    expect(hasTextExtension("image.png")).toBe(false);
    expect(hasTextExtension("archive.zip")).toBe(false);
  });
});

describe("isWithinSizeLimit", () => {
  it("respects the default 512 KiB limit", () => {
    expect(isWithinSizeLimit(512 * 1024)).toBe(true);
    expect(isWithinSizeLimit(512 * 1024 + 1)).toBe(false);
  });

  it("respects a custom limit", () => {
    expect(isWithinSizeLimit(10, 10)).toBe(true);
    expect(isWithinSizeLimit(11, 10)).toBe(false);
  });
});

describe("isBinaryContent", () => {
  it("detects NUL bytes within the first 8 KiB", () => {
    const buf = new Uint8Array([0x68, 0x69, 0x00, 0x00]);
    expect(isBinaryContent(buf)).toBe(true);
  });

  it("accepts plain text", () => {
    const buf = new TextEncoder().encode("hello world\n");
    expect(isBinaryContent(buf)).toBe(false);
  });
});

describe("isIncludedInTree", () => {
  it("combines path, extension and size checks", () => {
    expect(isIncludedInTree("src/app.ts", 100)).toBe(true);
    expect(isIncludedInTree("node_modules/x.ts", 100)).toBe(false);
    expect(isIncludedInTree("image.png", 100)).toBe(false);
    expect(isIncludedInTree("big.ts", 999999)).toBe(false);
  });
});
