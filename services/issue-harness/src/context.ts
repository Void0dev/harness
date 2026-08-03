import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ProjectWorkspaceOptions = {
  contextDir: string;
  remoteUrl: string;
  baseBranch: string;
  gitEnv?: NodeJS.ProcessEnv;
};

export async function prepareProjectWorkspace(options: ProjectWorkspaceOptions) {
  const contextDir = path.resolve(options.contextDir);
  if (contextDir === path.parse(contextDir).root) {
    throw new Error("Context checkout must not use a filesystem root");
  }
  const parent = path.dirname(contextDir);
  await fs.mkdir(parent, { recursive: true });
  await assertNotSymlink(parent);

  const gitDirectory = path.join(contextDir, ".git");
  try {
    const stat = await fs.lstat(contextDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Context checkout must be a real directory");
    }
    await fs.access(gitDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await git(parent, options.gitEnv, "clone", "--single-branch", "--branch", options.baseBranch, options.remoteUrl, contextDir);
  }

  await git(contextDir, options.gitEnv, "fetch", "--prune", "origin", options.baseBranch);
  await git(contextDir, options.gitEnv, "config", "core.hooksPath", path.join(contextDir, ".git", "disabled-hooks"));
  await git(contextDir, options.gitEnv, "config", "core.sharedRepository", "group");
  await git(contextDir, options.gitEnv, "config", "user.name", "OpenCode");
  await git(contextDir, options.gitEnv, "config", "user.email", "opencode@users.noreply.github.com");

  let branch = (await git(contextDir, options.gitEnv, "branch", "--show-current")).trim();
  const clean = (await git(contextDir, options.gitEnv, "status", "--porcelain=v1", "--untracked-files=all")).trim() === "";
  const remote = `origin/${options.baseBranch}`;
  if (!branch && clean) {
    const [head, remoteHead] = await Promise.all([
      git(contextDir, options.gitEnv, "rev-parse", "HEAD"),
      git(contextDir, options.gitEnv, "rev-parse", remote),
    ]);
    if (head.trim() === remoteHead.trim()) {
      await git(contextDir, options.gitEnv, "switch", "-C", options.baseBranch, remote);
      await git(contextDir, options.gitEnv, "branch", "--set-upstream-to", remote, options.baseBranch);
      branch = options.baseBranch;
    }
  }

  let updated = false;
  if (branch === options.baseBranch && clean) {
    const before = (await git(contextDir, options.gitEnv, "rev-parse", "HEAD")).trim();
    let canFastForward = true;
    try {
      await git(contextDir, options.gitEnv, "merge-base", "--is-ancestor", before, remote);
    } catch (error) {
      if ((error as { code?: number | string }).code !== 1) throw error;
      canFastForward = false;
    }
    if (canFastForward) {
      await git(contextDir, options.gitEnv, "merge", "--ff-only", remote);
      updated = before !== (await git(contextDir, options.gitEnv, "rev-parse", "HEAD")).trim();
    }
  }
  const revision = (await git(contextDir, options.gitEnv, "rev-parse", "HEAD")).trim();
  return { contextDir, revision, updated };
}

async function git(cwd: string, extraEnv: NodeJS.ProcessEnv | undefined, ...args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
  });
  return result.stdout;
}

async function assertNotSymlink(directory: string) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink()) throw new Error("Context checkout parent must not be a symbolic link");
}
