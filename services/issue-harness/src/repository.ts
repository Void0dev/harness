import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ensureSharedRuntimeDirectory } from "./security.js";

const execFileAsync = promisify(execFile);
const githubName = /^[A-Za-z0-9_.-]+$/;
const gitBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

export type IsolatedExecutionWorkspaceOptions = {
  dataDir: string;
  issueNumber: number;
  remoteUrl: string;
  baseBranch: string;
  gitEnv?: NodeJS.ProcessEnv;
};

export type IsolatedExecutionWorkspace = {
  workspace: string;
  baseSha: string;
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

export async function prepareIsolatedExecutionWorkspace(
  options: IsolatedExecutionWorkspaceOptions,
): Promise<IsolatedExecutionWorkspace> {
  if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber <= 0) {
    throw new Error(`Invalid issue number: ${options.issueNumber}`);
  }
  assertSafeName("base branch", options.baseBranch);

  const runsRoot = path.resolve(options.dataDir, "runs", `issue-${options.issueNumber}`);
  await ensureSharedRuntimeDirectory(path.resolve(options.dataDir, "runs"));
  await ensureSharedRuntimeDirectory(runsRoot);
  const workspace = await fs.mkdtemp(path.join(runsRoot, "run-"));
  await fs.chmod(workspace, 0o2770);
  await isolatedGit(
    path.dirname(workspace),
    options.gitEnv,
    "clone",
    "--template=",
    "--no-local",
    "--no-hardlinks",
    "--no-tags",
    "--single-branch",
    "--branch",
    options.baseBranch,
    options.remoteUrl,
    workspace,
  );
  await isolatedGit(workspace, undefined, "config", "core.hooksPath", "/dev/null");
  await isolatedGit(workspace, undefined, "config", "user.name", "OpenCode Harness");
  await isolatedGit(workspace, undefined, "config", "user.email", "opencode-harness@users.noreply.github.com");
  const baseSha = await isolatedGit(workspace, undefined, "rev-parse", "HEAD");
  return { workspace, baseSha };
}

export async function branchHasCommits(
  workspace: string,
  baseRef: string,
  branch: string,
) {
  const count = await isolatedGit(workspace, undefined, "rev-list", "--count", `${baseRef}..${branch}`);
  return Number.parseInt(count, 10) > 0;
}

export async function branchHead(workspace: string, branch: string) {
  if (!gitBranch.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) {
    throw new Error(`Invalid execution branch: ${branch}`);
  }
  const head = await isolatedGit(workspace, undefined, "rev-parse", branch);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) throw new Error("Invalid branch HEAD");
  return head;
}

export async function worktreeIsClean(workspace: string) {
  return (await isolatedGit(workspace, undefined, "status", "--porcelain=v1", "--untracked-files=all")) === "";
}

export async function createExecutionBranch(workspace: string, branch: string) {
  if (!gitBranch.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) {
    throw new Error(`Invalid execution branch: ${branch}`);
  }
  await isolatedGit(workspace, undefined, "switch", "-c", branch);
}

function assertSafeName(label: string, value: string) {
  if (!githubName.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

async function isolatedGit(cwd: string, gitEnv: NodeJS.ProcessEnv | undefined, ...args: string[]) {
  const result = await execFileAsync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "diff.external=",
    "-c", "credential.helper=",
    "-c", "protocol.ext.allow=never",
    ...args,
  ], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      XDG_CONFIG_HOME: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      ...allowlistedGitAuthEnvironment(gitEnv),
    },
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function allowlistedGitAuthEnvironment(gitEnv: NodeJS.ProcessEnv | undefined) {
  if (!gitEnv) return {};
  const count = gitEnv.GIT_CONFIG_COUNT;
  if (!count || !/^\d+$/.test(count)) {
    throw new Error("Git auth environment must contain a numeric GIT_CONFIG_COUNT");
  }
  const allowed: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: count };
  for (let index = 0; index < Number(count); index += 1) {
    const keyName = `GIT_CONFIG_KEY_${index}`;
    const valueName = `GIT_CONFIG_VALUE_${index}`;
    const key = gitEnv[keyName];
    const value = gitEnv[valueName];
    if (!key || value === undefined || !key.startsWith("http.https://github.com/")) {
      throw new Error(`Git auth environment contains a non-allowlisted entry at index ${index}`);
    }
    allowed[keyName] = key;
    allowed[valueName] = value;
  }
  return allowed;
}
