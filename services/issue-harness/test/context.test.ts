import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareProjectWorkspace } from "../src/context.js";

const execFileAsync = promisify(execFile);

test("clones and fast-forwards one writable project workspace on stage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const contextDir = path.join(root, "context");

  await git(root, "init", "--bare", remote);
  await fs.mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.test");
  await fs.writeFile(path.join(source, "version.txt"), "one\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "initial");
  await git(source, "switch", "-c", "stage");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "stage");

  const first = await prepareProjectWorkspace({
    contextDir,
    remoteUrl: remote,
    baseBranch: "stage",
  });
  assert.equal(await fs.readFile(path.join(contextDir, "version.txt"), "utf8"), "one\n");
  assert.match(first.revision, /^[0-9a-f]{40}$/);

  await fs.writeFile(path.join(source, "version.txt"), "two\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "update");
  await git(source, "push", "origin", "stage");

  const second = await prepareProjectWorkspace({
    contextDir,
    remoteUrl: remote,
    baseBranch: "stage",
  });
  assert.equal(await fs.readFile(path.join(contextDir, "version.txt"), "utf8"), "two\n");
  assert.notEqual(second.revision, first.revision);
  assert.equal((await git(contextDir, "branch", "--show-current")).trim(), "stage");
});

test("preserves local project workspace changes instead of resetting them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const contextDir = path.join(root, "context");

  await git(root, "init", "--bare", remote);
  await fs.mkdir(source);
  await git(source, "init", "-b", "stage");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.test");
  await fs.writeFile(path.join(source, "version.txt"), "one\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "initial");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "stage");

  await prepareProjectWorkspace({ contextDir, remoteUrl: remote, baseBranch: "stage" });
  await fs.writeFile(path.join(contextDir, "version.txt"), "local work\n");
  await fs.writeFile(path.join(contextDir, "new.txt"), "untracked\n");

  const refreshed = await prepareProjectWorkspace({ contextDir, remoteUrl: remote, baseBranch: "stage" });

  assert.equal(await fs.readFile(path.join(contextDir, "version.txt"), "utf8"), "local work\n");
  assert.equal(await fs.readFile(path.join(contextDir, "new.txt"), "utf8"), "untracked\n");
  assert.equal(refreshed.updated, false);
});

test("migrates the legacy clean detached stage checkout to a writable stage branch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-legacy-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const contextDir = path.join(root, "context");

  await git(root, "init", "--bare", remote);
  await fs.mkdir(source);
  await git(source, "init", "-b", "stage");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.test");
  await fs.writeFile(path.join(source, "version.txt"), "one\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "initial");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "stage");

  await prepareProjectWorkspace({ contextDir, remoteUrl: remote, baseBranch: "stage" });
  await git(contextDir, "checkout", "--detach", "origin/stage");

  await prepareProjectWorkspace({ contextDir, remoteUrl: remote, baseBranch: "stage" });

  assert.equal((await git(contextDir, "branch", "--show-current")).trim(), "stage");
  assert.equal((await git(contextDir, "status", "--porcelain=v1")).trim(), "");
});

async function git(cwd: string, ...args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  });
  return result.stdout;
}
