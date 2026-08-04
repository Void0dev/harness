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

  for (const run of options.states) {
    const issueRoot = path.join(runsRoot, `issue-${run.issueNumber}`);
    const currentWorkspace = trustedWorkspace(run.workspace, issueRoot);
    const expiresCurrentWorkspace = run.status === "finished"
      && Date.parse(run.updatedAt) + options.retentionMs <= now.getTime();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(issueRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

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
  for (const run of options.states) {
    if (run.status !== "finished") throw new Error("Only finished runs may be pruned from workspace storage");
    const issueRoot = path.join(runsRoot, `issue-${run.issueNumber}`);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(issueRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      await fs.rm(path.join(issueRoot, entry.name), { recursive: true, force: true });
    }
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
