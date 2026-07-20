import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createPublicationArtifact } from "../src/artifact.js";
import { publishArtifact, StalePublicationArtifactError } from "../src/publisher.js";
import { prepareIsolatedExecutionWorkspace } from "../src/repository.js";

const execFileAsync = promisify(execFile);

test("publishes a validated artifact from a fresh hook-isolated clone", async (t) => {
  const fixture = await createRemoteFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const execution = await prepareIsolatedExecutionWorkspace({
    dataDir: path.join(fixture.root, "data"),
    issueNumber: 21,
    remoteUrl: fixture.remote,
    baseBranch: "stage",
  });
  await git(execution.workspace, "switch", "-c", "codex/issue-21-safe-change");
  await fs.writeFile(path.join(execution.workspace, "version.txt"), "v2\n");
  await git(execution.workspace, "add", "version.txt");
  await git(execution.workspace, "commit", "-m", "attacker controlled message");
  const artifact = await createPublicationArtifact({
    dataDir: path.join(fixture.root, "data"),
    issueNumber: 21,
    branch: "codex/issue-21-safe-change",
    workspace: execution.workspace,
    baseSha: execution.baseSha,
  });

  const hostileHooks = path.join(fixture.root, "hostile-hooks");
  const hookSentinel = path.join(fixture.root, "hook-ran");
  const hostileConfig = path.join(fixture.root, "hostile.gitconfig");
  await fs.mkdir(hostileHooks);
  await fs.writeFile(
    path.join(hostileHooks, "pre-push"),
    `#!/bin/sh\nprintf compromised > "${hookSentinel}"\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(hostileConfig, `[core]\n\thooksPath = ${hostileHooks}\n`);
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = hostileConfig;
  t.after(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
  });

  const result = await publishArtifact({
    dataDir: path.join(fixture.root, "data"),
    remoteUrl: fixture.remote,
    baseBranch: "stage",
    issueNumber: 21,
    branch: "codex/issue-21-safe-change",
    artifact,
  });
  const retry = await publishArtifact({
    dataDir: path.join(fixture.root, "data"),
    remoteUrl: fixture.remote,
    baseBranch: "stage",
    issueNumber: 21,
    branch: "codex/issue-21-safe-change",
    artifact,
  });

  assert.match(result.commitSha, /^[0-9a-f]{40}$/);
  assert.equal(retry.commitSha, result.commitSha);
  assert.equal(
    await gitBare(fixture.remote, "rev-parse", "refs/heads/codex/issue-21-safe-change"),
    result.commitSha,
  );
  const inspection = path.join(fixture.root, "inspection");
  await git(fixture.root, "clone", "--branch", "codex/issue-21-safe-change", fixture.remote, inspection);
  assert.equal(await fs.readFile(path.join(inspection, "version.txt"), "utf8"), "v2\n");
  assert.equal(await git(inspection, "log", "-1", "--pretty=%s"), "Automated harness change for issue #21");
  await assert.rejects(fs.access(hookSentinel));
});

test("reports a changed base as a typed stale-artifact failure", async (t) => {
  const fixture = await createRemoteFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const dataDir = path.join(fixture.root, "data");
  const execution = await prepareIsolatedExecutionWorkspace({
    dataDir,
    issueNumber: 22,
    remoteUrl: fixture.remote,
    baseBranch: "stage",
  });
  await git(execution.workspace, "switch", "-c", "codex/issue-22-stale");
  await fs.writeFile(path.join(execution.workspace, "version.txt"), "agent-change\n");
  await git(execution.workspace, "add", "version.txt");
  await git(execution.workspace, "commit", "-m", "agent change");
  const artifact = await createPublicationArtifact({
    dataDir,
    issueNumber: 22,
    branch: "codex/issue-22-stale",
    workspace: execution.workspace,
    baseSha: execution.baseSha,
  });

  await fs.writeFile(path.join(fixture.source, "base-advanced.txt"), "advanced\n");
  await git(fixture.source, "add", ".");
  await git(fixture.source, "commit", "-m", "advance base");
  await git(fixture.source, "push", fixture.remote, "stage");

  await assert.rejects(
    publishArtifact({
      dataDir,
      remoteUrl: fixture.remote,
      baseBranch: "stage",
      issueNumber: 22,
      branch: "codex/issue-22-stale",
      artifact,
    }),
    (error) => error instanceof StalePublicationArtifactError
      && error.code === "publication_base_changed",
  );
});

async function createRemoteFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-publisher-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(source);
  await git(source, "init", "-b", "stage");
  await git(source, "config", "user.name", "Harness Test");
  await git(source, "config", "user.email", "harness@example.invalid");
  await fs.writeFile(path.join(source, "version.txt"), "v1\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "base");
  await git(root, "clone", "--bare", source, remote);
  return { root, remote, source };
}

async function git(cwd: string, ...args: string[]) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function gitBare(repository: string, ...args: string[]) {
  const result = await execFileAsync("git", ["--git-dir", repository, ...args]);
  return result.stdout.trim();
}
