import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { IssueRunState } from "./state.js";

type CleanupExpiredWorkspacesOptions = {
  dataDir: string;
  states: IssueRunState[];
  now?: Date;
  retentionMs: number;
};

type CleanupPrunedFinishedWorkspacesOptions = {
  dataDir: string;
  states: IssueRunState[];
};

export async function cleanupExpiredWorkspaces(options: CleanupExpiredWorkspacesOptions) {
  if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < 1) {
    throw new Error("Workspace retention must be a positive integer number of milliseconds");
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Workspace cleanup requires a valid current time");
  const runsRoot = path.resolve(options.dataDir, "runs");
  const realRunsRoot = await realDirectoryPath(runsRoot);
  if (!realRunsRoot) return;

  for (const run of options.states) {
    const issueRoot = path.join(runsRoot, `issue-${run.issueNumber}`);
    const currentWorkspace = trustedWorkspace(run.workspace, issueRoot);
    const expiresCurrentWorkspace = run.status === "finished"
      && Date.parse(run.updatedAt) + options.retentionMs <= now.getTime();
    const entries = await trustedDirectoryEntries(issueRoot, realRunsRoot);
    if (!entries) continue;

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const candidate = path.join(issueRoot, entry.name);
      if (candidate === currentWorkspace && !expiresCurrentWorkspace) continue;
      await fs.rm(candidate, { recursive: true, force: true });
    }
  }
}

export async function cleanupPrunedFinishedWorkspaces(options: CleanupPrunedFinishedWorkspacesOptions) {
  const runsRoot = path.resolve(options.dataDir, "runs");
  const realRunsRoot = await realDirectoryPath(runsRoot);
  if (!realRunsRoot) return;
  for (const run of options.states) {
    if (run.status !== "finished") throw new Error("Only finished runs may be pruned from workspace storage");
    const issueRoot = path.join(runsRoot, `issue-${run.issueNumber}`);
    const entries = await trustedDirectoryEntries(issueRoot, realRunsRoot);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      await fs.rm(path.join(issueRoot, entry.name), { recursive: true, force: true });
    }
  }
}

async function trustedDirectoryEntries(directory: string, expectedParent: string) {
  const realDirectory = await realDirectoryPath(directory);
  if (!realDirectory || path.dirname(realDirectory) !== expectedParent) return undefined;
  return await fs.readdir(directory, { withFileTypes: true }) as Dirent[];
}

async function realDirectoryPath(directory: string) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return await fs.realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function trustedWorkspace(value: string | undefined, issueRoot: string) {
  if (!value) return undefined;
  const resolvedRoot = path.resolve(issueRoot);
  const resolvedWorkspace = path.resolve(value);
  if (
    path.dirname(resolvedWorkspace) !== resolvedRoot
    || !/^run-[A-Za-z0-9_-]+$/.test(path.basename(resolvedWorkspace))
  ) return undefined;
  return resolvedWorkspace;
}
