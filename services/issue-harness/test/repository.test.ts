import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  githubGitAuthEnv,
  githubRepositoryRemote,
  prepareRepositoryWorkspace,
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

test("rejects workspace path traversal segments", async () => {
  await assert.rejects(
    prepareRepositoryWorkspace({
      dataDir: "/tmp/harness",
      owner: "..",
      repo: "service",
      baseBranch: "stage",
      remoteUrl: "https://github.com/acme/service.git",
    }),
    /Invalid owner/,
  );
});

test("clones the configured target repository on its base branch", async (t) => {
  const fixture = await createRemoteFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const workspace = await prepareRepositoryWorkspace({
    dataDir: path.join(fixture.root, "data"),
    owner: "acme",
    repo: "service",
    baseBranch: "stage",
    remoteUrl: fixture.remote,
  });

  assert.equal(workspace, path.join(fixture.root, "data", "workspaces", "acme", "service"));
  assert.equal(await git(workspace, "branch", "--show-current"), "stage");
  assert.equal(await git(workspace, "remote", "get-url", "origin"), fixture.remote);
  assert.equal(await git(workspace, "config", "user.name"), "Codex Harness");
  assert.equal(await git(workspace, "config", "user.email"), "codex-harness@users.noreply.github.com");
  assert.equal(await fs.readFile(path.join(workspace, "version.txt"), "utf8"), "v1\n");
});

test("refreshes an existing workspace from the remote base branch", async (t) => {
  const fixture = await createRemoteFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const options = {
    dataDir: path.join(fixture.root, "data"),
    owner: "acme",
    repo: "service",
    baseBranch: "stage",
    remoteUrl: fixture.remote,
  };

  const workspace = await prepareRepositoryWorkspace(options);
  await fs.writeFile(path.join(fixture.source, "version.txt"), "v2\n");
  await git(fixture.source, "add", "version.txt");
  await git(fixture.source, "commit", "-m", "v2");
  await git(fixture.source, "push", "origin", "stage");

  const refreshed = await prepareRepositoryWorkspace(options);

  assert.equal(refreshed, workspace);
  assert.equal(await fs.readFile(path.join(workspace, "version.txt"), "utf8"), "v2\n");
  assert.equal(await git(workspace, "status", "--porcelain"), "");
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
