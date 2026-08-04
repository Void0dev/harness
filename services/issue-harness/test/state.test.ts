import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeRunForParent,
  nextRunAction,
  StateStore,
  type IssueRunState,
} from "../src/state.js";

function state(status: IssueRunState["status"], prUrl?: string): IssueRunState {
  return {
    issueNumber: 42,
    branch: "opencode/issue-42-retry",
    status,
    prUrl,
    updatedAt: new Date(0).toISOString(),
  };
}

test("finalizes a persisted completed pull request and runs only new work", () => {
  assert.equal(nextRunAction(state("finished", "https://github.com/acme/service/pull/1")), "finalize");
  assert.equal(nextRunAction(state("finished")), "wait");
  assert.equal(nextRunAction(), "run");
  assert.equal(nextRunAction(state("awaiting_human")), "wait");
  assert.equal(nextRunAction(state("running")), "wait");
  assert.equal(nextRunAction({
    ...state("running"),
    taskView: {
      schemaVersion: 1,
      issueNumber: 42,
      title: "Queued task",
      status: "queued",
      stages: ["accepted"],
      updatedAt: new Date(0).toISOString(),
    },
  }), "run");
});

test("reconciles a persisted publishing run instead of starting another worker", () => {
  assert.equal(nextRunAction({
    ...state("running"),
    workspace: "/data/runs/issue-42/run-abc",
    baseSha: "a".repeat(40),
    taskView: {
      schemaVersion: 1,
      issueNumber: 42,
      title: "Publish existing work",
      status: "publishing",
      stages: ["accepted", "studying", "coding", "publishing"],
      updatedAt: new Date(0).toISOString(),
    },
  }), "reconcile-publication");
});

test("resumes the same worker after a human answer or technical retry", () => {
  assert.equal(nextRunAction({
    ...state("running"),
    awaitingAction: "resume_child",
    pendingHumanReply: "Retry the GitHub operation",
    lastSessionId: "ses_worker_12345678",
    workspace: "/data/runs/issue-42/run-abc",
    baseSha: "a".repeat(40),
  }), "resume");
});

test("reruns only after an explicit retry when the previous worker cannot be resumed", () => {
  assert.equal(nextRunAction({
    ...state("running"),
    awaitingAction: "rerun",
    pendingHumanReply: "Retry the interrupted operation after the reported technical failure.",
  }), "run");
});

test("loads legacy publication and merge state but persists only the simple run envelope", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-legacy-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateDirectory = path.join(dataDir, "state");
  await fs.mkdir(stateDirectory);
  await fs.writeFile(path.join(stateDirectory, "runs.json"), `${JSON.stringify({
    schemaVersion: 3,
    runs: [{
      issueNumber: 42,
      branch: "opencode/issue-42-retry",
      status: "publish_pending",
      publicationArtifact: {
        manifestPath: "/data/artifacts/issue-42/manifest.json",
        manifestSha256: "a".repeat(64),
      },
      publishedCommitSha: "b".repeat(40),
      lastLogPath: "/data/logs/issue-42.log",
      prNumber: 83,
      prHeadSha: "d".repeat(40),
      lastSessionId: "ses_worker_12345678",
      workspace: "/data/runs/issue-42/run-old",
      baseSha: "c".repeat(40),
      taskView: {
        schemaVersion: 1,
        issueNumber: 42,
        title: "Legacy publication",
        status: "publishing",
        stages: ["accepted", "studying", "coding", "publishing"],
        updatedAt: new Date(0).toISOString(),
      },
      updatedAt: new Date(0).toISOString(),
    }],
    mergeOperations: [{ key: "obsolete" }],
  })}\n`);
  const store = new StateStore(dataDir);

  await store.load();
  assert.equal(store.get(42)?.status, "awaiting_human");
  assert.equal(store.get(42)?.awaitingAction, "rerun");
  assert.match(store.get(42)?.branch ?? "", /^opencode\/issue-42-retry-agent-/);
  assert.equal(store.get(42)?.lastSessionId, undefined);
  assert.equal(store.get(42)?.workspace, undefined);
  assert.equal(store.get(42)?.baseSha, undefined);
  assert.equal("lastLogPath" in (store.get(42) as object), false);
  assert.equal("prNumber" in (store.get(42) as object), false);
  assert.equal("prHeadSha" in (store.get(42) as object), false);
  assert.equal(store.get(42)?.taskView?.status, "failed");
  assert.equal("publicationArtifact" in (store.get(42) as object), false);
  await store.set({ issueNumber: 43, branch: "opencode/issue-43-new", status: "running" });

  const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "runs.json"), "utf8"));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.runs.length, 2);
  assert.equal("mergeOperations" in persisted, false);
  assert.doesNotMatch(JSON.stringify(persisted), /publicationArtifact|publishedCommitSha|mergeOperation/);
  assert.equal((await fs.stat(path.join(stateDirectory, "runs.json"))).mode & 0o777, 0o600);
});

test("reruns legacy retry-publish failures with the current worker contract", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-retry-publish-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateDirectory = path.join(dataDir, "state");
  await fs.mkdir(stateDirectory);
  await fs.writeFile(path.join(stateDirectory, "runs.json"), `${JSON.stringify({
    schemaVersion: 3,
    runs: [{
      issueNumber: 44,
      branch: "opencode/issue-44-old-publisher",
      status: "awaiting_human",
      awaitingAction: "retry_publish",
      lastSessionId: "ses_worker_12345678",
      workspace: "/data/runs/issue-44/run-old",
      baseSha: "d".repeat(40),
      updatedAt: new Date(0).toISOString(),
    }],
    mergeOperations: [],
  })}\n`);
  const store = new StateStore(dataDir);

  await store.load();

  assert.equal(store.get(44)?.awaitingAction, "rerun");
  assert.match(store.get(44)?.branch ?? "", /^opencode\/issue-44-old-publisher-agent-/);
  assert.equal(store.get(44)?.lastSessionId, undefined);
  assert.equal(store.get(44)?.workspace, undefined);
  assert.equal(store.get(44)?.baseSha, undefined);
});

test("serializes concurrent state writes into one valid snapshot", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-race-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();

  await Promise.all(Array.from({ length: 20 }, (_, index) => store.set({
    issueNumber: index + 1,
    branch: `opencode/issue-${index + 1}-test`,
    status: "running",
  })));

  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "state", "runs.json"), "utf8"));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.runs.length, 20);
  await assert.rejects(fs.access(path.join(dataDir, "state", "runs.json.tmp")));
});

test("bounds durable history by pruning older finished runs", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-prune-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateDirectory = path.join(dataDir, "state");
  await fs.mkdir(stateDirectory);
  const runs = [1, 2, 3, 4].map((issueNumber) => ({
    issueNumber,
    branch: `opencode/issue-${issueNumber}`,
    status: "finished",
    prUrl: `https://github.com/acme/service/pull/${issueNumber}`,
    updatedAt: new Date(issueNumber * 1_000).toISOString(),
  }));
  runs.push({
    issueNumber: 5,
    branch: "opencode/issue-5-active",
    status: "running",
    prUrl: undefined,
    updatedAt: new Date(0).toISOString(),
  });
  await fs.writeFile(path.join(stateDirectory, "runs.json"), `${JSON.stringify({ schemaVersion: 2, runs })}\n`);
  const store = new StateStore(dataDir);
  await store.load();

  assert.deepEqual((await store.pruneFinished(2)).map((run) => run.issueNumber), [2, 1]);
  assert.deepEqual(store.all().map((run) => run.issueNumber), [3, 4, 5]);
  const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "runs.json"), "utf8"));
  assert.deepEqual(persisted.runs.map((run: IssueRunState) => run.issueNumber), [3, 4, 5]);
});

test("keeps pruned runs durable when external cleanup fails", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-prune-failure-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();
  await store.set({ issueNumber: 1, branch: "opencode/issue-1", status: "finished", prUrl: "https://github.com/acme/service/pull/1" });
  await store.set({ issueNumber: 2, branch: "opencode/issue-2", status: "finished", prUrl: "https://github.com/acme/service/pull/2" });

  await assert.rejects(store.pruneFinished(1, async () => {
    throw new Error("workspace cleanup failed");
  }), /workspace cleanup failed/);

  assert.deepEqual(store.all().map((run) => run.issueNumber), [1, 2]);
});

test("persists parent, worker, pull request URL, and human reply state", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-fields-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();

  await store.set({
    issueNumber: 57,
    branch: "opencode/issue-57-login",
    status: "finished",
    parentSessionId: "ses_parent_12345678",
    lastSessionId: "ses_worker_12345678",
    workspace: "/opt/issue-harness/data/runs/issue-57/run-abc",
    baseSha: "a".repeat(40),
    prUrl: "https://github.com/acme/service/pull/83",
  });

  const reloaded = new StateStore(dataDir);
  await reloaded.load();
  assert.equal(reloaded.get(57)?.parentSessionId, "ses_parent_12345678");
  assert.equal(reloaded.get(57)?.prUrl, "https://github.com/acme/service/pull/83");
});

test("rejects malformed durable state", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-invalid-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();

  await assert.rejects(store.set({
    issueNumber: 59,
    branch: "opencode/issue-59-comments",
    status: "awaiting_human",
    humanQuestionCommentId: 0,
  } as never), /human question comment/i);
  await assert.rejects(store.set({
    issueNumber: 58,
    branch: "opencode/issue-58-login",
    status: "running",
    parentSessionId: "../../secret",
  }), /Invalid OpenCode session ID/);
});

test("refuses ambiguous unfinished runs for one parent session", () => {
  const parentSessionId = "ses_parent_12345678";
  assert.throws(() => activeRunForParent([
    { ...state("running"), issueNumber: 57, parentSessionId },
    { ...state("awaiting_human"), issueNumber: 58, parentSessionId },
  ], parentSessionId), /multiple unfinished Issues/i);
});
