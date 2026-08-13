/**
 * Optional GitHub API metadata.
 *
 * A single GET /repos/:owner/:name — no token required. Any network failure
 * degrades to `null` so metadata never blocks repository import. Tests inject
 * a `fetchFn` mock; they never issue real network requests.
 */

export interface FetchLike {
  (
    input: string,
    init?: { headers?: Record<string, string> },
  ): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

export interface RepoMeta {
  fullName: string;
  description?: string;
  defaultBranch?: string;
  stars?: number;
  language?: string;
  htmlUrl?: string;
}

export interface GitHubMetaOptions {
  fetchFn?: FetchLike;
  token?: string;
}

export async function getRepoMeta(
  owner: string,
  name: string,
  opts: GitHubMetaOptions = {},
): Promise<RepoMeta | null> {
  const fetchFn: FetchLike =
    opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repocoach",
  };
  if (opts.token !== undefined) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  try {
    const response = await fetchFn(
      `https://api.github.com/repos/${owner}/${name}`,
      { headers },
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as Record<string, unknown>;
    return {
      fullName:
        typeof data.full_name === "string"
          ? data.full_name
          : `${owner}/${name}`,
      description:
        typeof data.description === "string" ? data.description : undefined,
      defaultBranch:
        typeof data.default_branch === "string"
          ? data.default_branch
          : undefined,
      stars:
        typeof data.stargazers_count === "number"
          ? data.stargazers_count
          : undefined,
      language: typeof data.language === "string" ? data.language : undefined,
      htmlUrl: typeof data.html_url === "string" ? data.html_url : undefined,
    };
  } catch {
    return null;
  }
}
