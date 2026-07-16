import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const githubName = /^[A-Za-z0-9_.-]+$/;

export type RepositoryWorkspaceOptions = {
  dataDir: string;
  owner: string;
  repo: string;
  baseBranch: string;
  remoteUrl: string;
  gitEnv?: NodeJS.ProcessEnv;
};

export function githubRepositoryRemote(owner: string, repo: string) {
  assertSafeName("owner", owner);
  assertSafeName("repo", repo);
  return `https://github.com/${owner}/${repo}.git`;
}

export function githubGitAuthEnv(token: string): NodeJS.ProcessEnv {
  if (!token) throw new Error("GitHub token is required");
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export async function prepareRepositoryWorkspace(options: RepositoryWorkspaceOptions) {
  assertSafeName("owner", options.owner);
  assertSafeName("repo", options.repo);
  assertSafeName("base branch", options.baseBranch);

  const workspaceRoot = path.resolve(options.dataDir, "workspaces");
  const workspace = path.resolve(workspaceRoot, options.owner, options.repo);
  if (!workspace.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Resolved repository workspace escapes the workspace root");
  }
  const gitDirectory = path.join(workspace, ".git");

  if (!(await exists(gitDirectory))) {
    await fs.mkdir(path.dirname(workspace), { recursive: true });
    await git(
      path.dirname(workspace),
      options.gitEnv,
      "clone",
      "--no-tags",
      "--single-branch",
      "--branch",
      options.baseBranch,
      options.remoteUrl,
      workspace,
    );
    await configureGitIdentity(workspace, options.gitEnv);
    return workspace;
  }

  const currentRemote = await git(workspace, options.gitEnv, "remote", "get-url", "origin");
  if (currentRemote !== options.remoteUrl) {
    throw new Error(`Refusing to reuse ${workspace}: origin is ${currentRemote}, expected ${options.remoteUrl}`);
  }

  await git(workspace, options.gitEnv, "fetch", "--no-tags", "--prune", "origin", options.baseBranch);
  await git(workspace, options.gitEnv, "checkout", "-B", options.baseBranch, `origin/${options.baseBranch}`);
  await git(workspace, options.gitEnv, "reset", "--hard", `origin/${options.baseBranch}`);
  await git(workspace, options.gitEnv, "clean", "-ffd");
  await configureGitIdentity(workspace, options.gitEnv);
  return workspace;
}

export async function branchHasCommits(
  workspace: string,
  baseRef: string,
  branch: string,
  gitEnv?: NodeJS.ProcessEnv,
) {
  const count = await git(workspace, gitEnv, "rev-list", "--count", `${baseRef}..${branch}`);
  return Number.parseInt(count, 10) > 0;
}

async function configureGitIdentity(workspace: string, gitEnv: NodeJS.ProcessEnv | undefined) {
  await git(workspace, gitEnv, "config", "user.name", "Codex Harness");
  await git(workspace, gitEnv, "config", "user.email", "codex-harness@users.noreply.github.com");
}

function assertSafeName(label: string, value: string) {
  if (!githubName.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

async function exists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function git(cwd: string, gitEnv: NodeJS.ProcessEnv | undefined, ...args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...gitEnv },
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}
