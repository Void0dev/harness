import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  branchHead,
  prepareIsolatedExecutionWorkspace,
  githubGitAuthEnv,
  githubRepositoryRemote,
  worktreeIsClean,
} from "../src/repository.js";

const execFileAsync = promisify(execFile);

test("builds a credential-free GitHub remote URL", () => {
  assert.equal(githubRepositoryRemote("acme", "service"), "https://github.com/acme/service.git");
});

test("passes GitHub credentials through a process-local extra header", () => {
  const env = githubGitAuthEnv("top-secret-token");

  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  assert.match(env.GIT_CONFIG_VALUE_0 ?? "", /^AUTHORIZATION: basic /);
  assert.doesNotMatch(env.GIT_CONFIG_VALUE_0 ?? "", /top-secret-token/);
});

test("rejects GitHub repository path traversal segments", () => {
  assert.throws(() => githubRepositoryRemote("..", "service"), /Invalid owner/);
});

test("creates an execution clone with independent Git metadata and a credential-free origin", async (t) => {
  const fixture = await createRemoteFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const hostileTemplate = path.join(fixture.root, "hostile-template");
  const hostileHooks = path.join(hostileTemplate, "hooks");
  const hookSentinel = path.join(fixture.root, "hook-ran");
  await fs.mkdir(hostileHooks, { recursive: true });
  await fs.writeFile(
    path.join(hostileHooks, "post-checkout"),
    `#!/bin/sh\nprintf compromised > "${hookSentinel}"\n`,
    { mode: 0o755 },
  );
  const previousTemplate = process.env.GIT_TEMPLATE_DIR;
  process.env.GIT_TEMPLATE_DIR = hostileTemplate;
  t.after(() => {
    if (previousTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplate;
  });

  const dataDir = path.join(fixture.root, "data");
  const runsRoot = path.join(dataDir, "runs", "issue-17");
  await fs.mkdir(runsRoot, { recursive: true, mode: 0o755 });
  await fs.chmod(runsRoot, 0o755);
  const execution = await prepareIsolatedExecutionWorkspace({
    dataDir,
    issueNumber: 17,
    remoteUrl: fixture.remote,
    baseBranch: "stage",
  });

  await assert.rejects(fs.access(path.join(execution.workspace, ".git", "objects", "info", "alternates")));
  const trustedObjectFiles = await objectFileIds(path.join(fixture.remote, "objects"));
  const executionObjectFiles = await objectFileIds(path.join(execution.workspace, ".git", "objects"));
  assert.deepEqual([...executionObjectFiles].filter((id) => trustedObjectFiles.has(id)), []);
  assert.equal(await git(execution.workspace, "remote", "get-url", "origin"), fixture.remote);
  assert.equal(await git(execution.workspace, "config", "core.hooksPath"), "/dev/null");
  assert.match(execution.baseSha, /^[0-9a-f]{40}$/);
  assert.equal(await branchHead(execution.workspace, "stage"), execution.baseSha);
  assert.equal(await worktreeIsClean(execution.workspace), true);
  await fs.writeFile(path.join(execution.workspace, "untracked.txt"), "pending\n");
  assert.equal(await worktreeIsClean(execution.workspace), false);
  assert.equal((await fs.stat(runsRoot)).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(path.join(execution.workspace, "version.txt"), "utf8"), "v1\n");
  await assert.rejects(fs.access(hookSentinel));
});

async function createRemoteFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-repository-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(source);
  await git(source, "init", "-b", "stage");
  await git(source, "config", "user.name", "Harness Test");
  await git(source, "config", "user.email", "harness@example.invalid");
  await fs.writeFile(path.join(source, "version.txt"), "v1\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "v1");
  await git(root, "clone", "--bare", source, remote);
  await git(source, "remote", "add", "origin", remote);
  return { root, source, remote };
}

async function git(cwd: string, ...args: string[]) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function objectFileIds(root: string) {
  const ids = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(entryPath);
        ids.add(`${stat.dev}:${stat.ino}`);
      }
    }
  }
  return ids;
}
