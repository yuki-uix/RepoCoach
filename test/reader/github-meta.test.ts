import { describe, expect, it, vi } from "vitest";
import { getRepoMeta, type FetchLike } from "../../src/reader/github-meta";

function okFetch(data: unknown): FetchLike {
  return vi.fn(async () => ({ ok: true, json: async () => data }));
}

describe("getRepoMeta", () => {
  it("maps the GitHub API response", async () => {
    const meta = await getRepoMeta("owner", "name", {
      fetchFn: okFetch({
        full_name: "owner/name",
        description: "desc",
        default_branch: "main",
        stargazers_count: 42,
        language: "TypeScript",
        html_url: "https://github.com/owner/name",
      }),
    });
    expect(meta).toEqual({
      fullName: "owner/name",
      description: "desc",
      defaultBranch: "main",
      stars: 42,
      language: "TypeScript",
      htmlUrl: "https://github.com/owner/name",
    });
  });

  it("falls back to owner/name when full_name is missing", async () => {
    const meta = await getRepoMeta("owner", "name", {
      fetchFn: okFetch({}),
    });
    expect(meta?.fullName).toBe("owner/name");
  });

  it("degrades to null on a network failure", async () => {
    const failing: FetchLike = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await getRepoMeta("owner", "name", { fetchFn: failing })).toBeNull();
  });

  it("degrades to null on a non-ok response", async () => {
    const notFound: FetchLike = vi.fn(async () => ({
      ok: false,
      json: async () => ({ message: "Not Found" }),
    }));
    expect(
      await getRepoMeta("owner", "name", { fetchFn: notFound }),
    ).toBeNull();
  });
});
