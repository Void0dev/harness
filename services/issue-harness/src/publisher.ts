import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertNoHighConfidenceSecrets,
  ensurePrivateRuntimeDirectory,
} from "./security.js";
import {
  loadPublicationArtifact,
  PublicationArtifactReference,
} from "./artifact.js";

const execFileAsync = promisify(execFile);

export class StalePublicationArtifactError extends Error {
  readonly code = "publication_base_changed" as const;

  constructor() {
    super("Publication artifact base no longer matches the current base branch");
    this.name = "StalePublicationArtifactError";
  }
}

export async function publishArtifact(options: {
  dataDir: string;
  remoteUrl: string;
  baseBranch: string;
  issueNumber: number;
  branch: string;
  artifact: PublicationArtifactReference;
  gitEnv?: NodeJS.ProcessEnv;
  configuredSecrets?: Array<string | undefined>;
}) {
  const loaded = await loadPublicationArtifact({
    dataDir: options.dataDir,
    issueNumber: options.issueNumber,
    branch: options.branch,
    reference: options.artifact,
  });
  const publisherRoot = path.resolve(options.dataDir, "publishers", `issue-${options.issueNumber}`);
  assertNoHighConfidenceSecrets(loaded.patch, options.configuredSecrets ?? []);
  await ensurePrivateRuntimeDirectory(path.resolve(options.dataDir, "publishers"));
  await ensurePrivateRuntimeDirectory(publisherRoot);
  const workspace = await fs.mkdtemp(path.join(publisherRoot, "publish-"));

  try {
    await trustedGit(
      path.dirname(workspace),
      options.gitEnv,
      undefined,
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
    const actualBaseSha = await trustedGit(workspace, undefined, undefined, "rev-parse", "HEAD");
    if (actualBaseSha !== loaded.manifest.baseSha) {
      throw new StalePublicationArtifactError();
    }

    await trustedGitWithInput(workspace, loaded.patch, "apply", "--check", "--index", "--binary", "-");
    await trustedGitWithInput(workspace, loaded.patch, "apply", "--index", "--binary", "-");
    const appliedPaths = (await trustedGit(
      workspace,
      undefined,
      undefined,
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "--",
    )).split("\0").filter(Boolean).sort();
    if (appliedPaths.join("\0") !== loaded.manifest.paths.join("\0")) {
      throw new Error("Applied publication paths do not match the trusted manifest");
    }

    await trustedGit(
      workspace,
      undefined,
      {
        GIT_AUTHOR_DATE: loaded.manifest.createdAt,
        GIT_COMMITTER_DATE: loaded.manifest.createdAt,
      },
      "-c",
      "user.name=Codex Harness",
      "-c",
      "user.email=codex-harness@users.noreply.github.com",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      `Automated harness change for issue #${options.issueNumber}`,
    );
    const commitSha = await trustedGit(workspace, undefined, undefined, "rev-parse", "HEAD");
    const remoteCommit = await readRemoteRef(options.remoteUrl, options.branch, options.gitEnv);
    if (remoteCommit) {
      if (remoteCommit === commitSha) return { commitSha };
      throw new Error(`Refusing to overwrite existing remote branch ${options.branch}`);
    }

    try {
      await trustedGit(
        workspace,
        options.gitEnv,
        undefined,
        "push",
        "--no-verify",
        `--force-with-lease=refs/heads/${options.branch}:`,
        options.remoteUrl,
        `HEAD:refs/heads/${options.branch}`,
      );
    } catch (error) {
      if (await readRemoteRef(options.remoteUrl, options.branch, options.gitEnv) !== commitSha) throw error;
    }
    return { commitSha };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function readRemoteRef(remoteUrl: string, branch: string, gitEnv: NodeJS.ProcessEnv | undefined) {
  const output = await trustedGit(
    process.cwd(),
    gitEnv,
    undefined,
    "ls-remote",
    "--refs",
    remoteUrl,
    `refs/heads/${branch}`,
  );
  if (!output) return undefined;
  const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\trefs\/heads\//.exec(output);
  if (!match) throw new Error(`Unexpected ls-remote output for ${branch}`);
  return match[1];
}

async function trustedGit(
  cwd: string,
  gitEnv: NodeJS.ProcessEnv | undefined,
  operationEnv: NodeJS.ProcessEnv | undefined,
  ...args: string[]
) {
  const result = await execFileAsync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
    {
      cwd,
      env: trustedGitEnvironment(gitEnv, operationEnv),
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return result.stdout.trim();
}

async function trustedGitWithInput(cwd: string, input: Buffer, ...args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
      {
        cwd,
        env: trustedGitEnvironment(undefined, undefined),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(new Error(
          `git ${args[0]} failed with exit code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ));
      }
    });
    child.stdin.end(input);
  });
}

function trustedGitEnvironment(
  gitEnv: NodeJS.ProcessEnv | undefined,
  operationEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "/usr/bin/false",
    LANG: "C",
    LC_ALL: "C",
    ...allowlistedGitAuthEnvironment(gitEnv),
    ...operationEnv,
  };
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
