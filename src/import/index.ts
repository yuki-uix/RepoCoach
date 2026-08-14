/**
 * Repository import — the "what did I just open" summary that sits on top of the
 * reader and feeds candidate generation.
 *
 * `buildRepositoryImport` composes the reader's tree / package-info / read-file
 * access (all already dual-gated, docs/architecture.md §6) into one structure:
 * the tree, the root package summary, the resolved entry candidates and the
 * resolved workspaces. A missing or unreadable `package.json` is a non-fatal
 * `packageError` — candidates still fall back to conventional entry paths, and
 * an empty repo produces a warning rather than a crash.
 */

import type {
  PackageInfo,
  Reader,
  Repository,
  TreeEntry,
} from "../reader/index.js";
import { resolveEntryCandidates } from "./entries.js";
import { resolveWorkspaces, type WorkspaceInfo } from "./workspaces.js";

export interface RepositoryImport {
  repo: Repository;
  tree: TreeEntry[];
  packageInfo: PackageInfo | null;
  /** Human-readable reason the root package.json is missing/unreadable. */
  packageError?: string;
  entryCandidates: string[];
  workspaces: WorkspaceInfo[];
  /** Non-fatal observations (e.g. an empty repository). */
  warnings: string[];
}

/** A repository narrowed to one selected workspace package. */
export interface NarrowedImport {
  tree: TreeEntry[];
  entryCandidates: string[];
  workspace?: WorkspaceInfo;
}

export function buildRepositoryImport(
  reader: Reader,
  repo: Repository,
): RepositoryImport {
  const tree = reader.getTree(repo);
  const warnings: string[] = [];
  if (tree.length === 0) {
    warnings.push("Repository contains no readable files");
  }

  const pkg = readRootPackage(reader, repo);
  const entryCandidates = resolveEntryCandidates(
    pkg.info?.entryPoints ?? [],
    tree,
  );
  const workspaces =
    pkg.info === null
      ? []
      : resolveWorkspaces(reader, repo, tree, pkg.info.workspaces);

  return {
    repo,
    tree,
    packageInfo: pkg.info,
    packageError: pkg.error,
    entryCandidates,
    workspaces,
    warnings,
  };
}

/** Narrow a full import to a single workspace package. */
export function narrowToWorkspace(
  imp: RepositoryImport,
  workspacePath: string,
): NarrowedImport {
  const workspace = imp.workspaces.find((item) => item.path === workspacePath);
  const prefix = `${workspacePath}/`;
  return {
    tree: imp.tree.filter((entry) => entry.path.startsWith(prefix)),
    entryCandidates: workspace?.entryCandidates ?? [],
    workspace,
  };
}

function readRootPackage(
  reader: Reader,
  repo: Repository,
): { info: PackageInfo | null; error?: string } {
  try {
    return { info: reader.getPackageInfo(repo) };
  } catch (error) {
    if (isMissingFile(error)) {
      return { info: null, error: "No package.json found in the repository" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { info: null, error: `Could not read package.json: ${message}` };
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export type { WorkspaceInfo } from "./workspaces.js";
