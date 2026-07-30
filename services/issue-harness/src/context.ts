import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RefreshContextOptions = {
  contextDir: string;
  remoteUrl: string;
  baseBranch: string;
  gitEnv?: NodeJS.ProcessEnv;
};

export function withFreshContext<T, R>(
  refresh: () => Promise<unknown>,
  next: (input: T) => Promise<R>,
) {
  return async (input: T) => {
    await refresh();
    return next(input);
  };
}

export async function refreshContextCheckout(options: RefreshContextOptions) {
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
    await git(parent, options.gitEnv, "clone", "--no-checkout", "--single-branch", "--branch", options.baseBranch, options.remoteUrl, contextDir);
  }

  await git(contextDir, options.gitEnv, "fetch", "--prune", "origin", options.baseBranch);
  await git(contextDir, options.gitEnv, "checkout", "--detach", `origin/${options.baseBranch}`);
  await git(contextDir, options.gitEnv, "reset", "--hard", `origin/${options.baseBranch}`);
  await git(contextDir, options.gitEnv, "clean", "-fdx");
  await git(contextDir, options.gitEnv, "config", "core.hooksPath", path.join(contextDir, ".git", "disabled-hooks"));
  const revision = (await git(contextDir, options.gitEnv, "rev-parse", "HEAD")).trim();
  return { contextDir, revision };
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
