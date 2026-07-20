import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createPublicationArtifact } from "../src/artifact.js";

const execFileAsync = promisify(execFile);

test("exports a content-addressed patch and path manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-artifact-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-b", "stage");
  await git(workspace, "config", "user.name", "Harness Test");
  await git(workspace, "config", "user.email", "harness@example.invalid");
  await fs.writeFile(path.join(workspace, "existing.txt"), "before\n");
  await git(workspace, "add", "existing.txt");
  await git(workspace, "commit", "-m", "base");
  const baseSha = await git(workspace, "rev-parse", "HEAD");
  await git(workspace, "switch", "-c", "codex/issue-7-change");
  await fs.writeFile(path.join(workspace, "existing.txt"), "after\n");
  await fs.writeFile(path.join(workspace, "new file.txt"), "new\n");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "change");

  const artifact = await createPublicationArtifact({
    dataDir: path.join(root, "data"),
    issueNumber: 7,
    branch: "codex/issue-7-change",
    workspace,
    baseSha,
  });

  const manifestBytes = await fs.readFile(artifact.manifestPath);
  assert.equal(sha256(manifestBytes), artifact.manifestSha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    schemaVersion: number;
    issueNumber: number;
    branch: string;
    baseSha: string;
    createdAt: string;
    patchFile: string;
    patchSha256: string;
    paths: string[];
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.issueNumber, 7);
  assert.equal(manifest.branch, "codex/issue-7-change");
  assert.equal(manifest.baseSha, baseSha);
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(manifest.paths, ["existing.txt", "new file.txt"]);
  assert.match(manifest.patchFile, /^[0-9a-f]{64}\.patch$/);
  const patchBytes = await fs.readFile(path.join(path.dirname(artifact.manifestPath), manifest.patchFile));
  assert.equal(sha256(patchBytes), manifest.patchSha256);
  assert.match(patchBytes.toString("utf8"), /diff --git a\/existing\.txt b\/existing\.txt/);
});

test("rejects a patch that creates a symbolic link", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-artifact-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-b", "stage");
  await git(workspace, "config", "user.name", "Harness Test");
  await git(workspace, "config", "user.email", "harness@example.invalid");
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "base");
  const baseSha = await git(workspace, "rev-parse", "HEAD");
  await git(workspace, "switch", "-c", "codex/issue-8-link");
  await fs.symlink("../../outside", path.join(workspace, "escape"));
  await git(workspace, "add", "escape");
  await git(workspace, "commit", "-m", "link");

  await assert.rejects(
    createPublicationArtifact({
      dataDir: path.join(root, "data"),
      issueNumber: 8,
      branch: "codex/issue-8-link",
      workspace,
      baseSha,
    }),
    /Unsupported artifact entry escape: 120000 blob/,
  );
});

test("rejects a patch containing high-confidence secret material", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-artifact-secret-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-b", "stage");
  await git(workspace, "config", "user.name", "Harness Test");
  await git(workspace, "config", "user.email", "harness@example.invalid");
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "base");
  const baseSha = await git(workspace, "rev-parse", "HEAD");
  await git(workspace, "switch", "-c", "codex/issue-9-secret");
  await fs.writeFile(path.join(workspace, "leak.txt"), `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}\n`);
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "secret");

  await assert.rejects(
    createPublicationArtifact({
      dataDir: path.join(root, "data"),
      issueNumber: 9,
      branch: "codex/issue-9-secret",
      workspace,
      baseSha,
    }),
    /credential material/,
  );
});

async function git(cwd: string, ...args: string[]) {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
