import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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

  await writeTrustedGitConfig(contextDir, options.remoteUrl, options.baseBranch);
  await git(
    contextDir,
    options.gitEnv,
    "fetch",
    "--prune",
    options.remoteUrl,
    `+refs/heads/${options.baseBranch}:refs/remotes/origin/${options.baseBranch}`,
  );

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
  const result = await execFileAsync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "diff.external=",
    "-c", "credential.helper=",
    "-c", "protocol.ext.allow=never",
    ...args,
  ], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: extraEnv?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      XDG_CONFIG_HOME: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      ...allowlistedGitAuthEnvironment(extraEnv),
    },
  });
  return result.stdout;
}

async function writeTrustedGitConfig(contextDir: string, remoteUrl: string, baseBranch: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(baseBranch) || baseBranch.includes("..")) {
    throw new Error("Invalid context base branch");
  }
  const gitDirectory = path.join(contextDir, ".git");
  const gitStat = await fs.lstat(gitDirectory);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw new Error("Context checkout Git directory must be a real directory");
  }
  const configPath = path.join(gitDirectory, "config");
  const currentBranch = await currentBranchFromHead(gitDirectory);
  const branches = new Set([baseBranch, ...(currentBranch ? [currentBranch] : [])]);
  const branchConfig = [...branches].map((branch) => [
    `[branch ${quoteGitConfig(branch)}]`,
    "\tremote = origin",
    `\tmerge = refs/heads/${branch}`,
  ].join("\n")).join("\n");
  const content = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    `\thooksPath = ${quoteGitConfig(path.join(gitDirectory, "disabled-hooks"))}`,
    "\tsharedRepository = group",
    '[remote "origin"]',
    `\turl = ${quoteGitConfig(remoteUrl)}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    branchConfig,
    "[user]",
    "\tname = OpenCode",
    "\temail = opencode@users.noreply.github.com",
    "",
  ].join("\n");
  const temporary = path.join(gitDirectory, `config.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, content, { flag: "wx", mode: 0o640 });
  await fs.rename(temporary, configPath);
}

async function currentBranchFromHead(gitDirectory: string) {
  const head = (await fs.readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
  const prefix = "ref: refs/heads/";
  if (!head.startsWith(prefix)) return undefined;
  const branch = head.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(branch) && !branch.includes("..")
    ? branch
    : undefined;
}

function quoteGitConfig(value: string) {
  if (/\r|\n|\0/.test(value)) throw new Error("Invalid Git configuration value");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function allowlistedGitAuthEnvironment(extraEnv: NodeJS.ProcessEnv | undefined) {
  if (!extraEnv?.GIT_CONFIG_COUNT) return {};
  if (!/^\d+$/.test(extraEnv.GIT_CONFIG_COUNT)) throw new Error("Invalid Git auth configuration count");
  const allowed: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: extraEnv.GIT_CONFIG_COUNT };
  for (let index = 0; index < Number(extraEnv.GIT_CONFIG_COUNT); index += 1) {
    const keyName = `GIT_CONFIG_KEY_${index}`;
    const valueName = `GIT_CONFIG_VALUE_${index}`;
    const key = extraEnv[keyName];
    const value = extraEnv[valueName];
    if (!key || value === undefined || !key.startsWith("http.https://github.com/")) {
      throw new Error("Invalid Git auth configuration entry");
    }
    allowed[keyName] = key;
    allowed[valueName] = value;
  }
  return allowed;
}

async function assertNotSymlink(directory: string) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink()) throw new Error("Context checkout parent must not be a symbolic link");
}
