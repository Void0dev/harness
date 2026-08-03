import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mergeOperationKey,
  productionOperationKey,
  reduceMergeOperation,
  type MergeOperation,
} from "../src/merge.js";
import {
  activeRunForParent,
  MAX_MERGE_OPERATION_RECORDS,
  nextRunAction,
  recoverStalePublication,
  StateStore,
  type IssueRunState,
} from "../src/state.js";

function state(
  status: IssueRunState["status"],
  prUrl?: string,
  publicationArtifact: IssueRunState["publicationArtifact"] | null = {
    manifestPath: "/data/artifacts/issue-42/manifest.json",
    manifestSha256: "a".repeat(64),
  },
): IssueRunState {
  return {
    issueNumber: 42,
    branch: "opencode/issue-42-retry",
    status,
    prUrl,
    publicationArtifact: publicationArtifact ?? undefined,
    updatedAt: new Date(0).toISOString(),
  };
}

test("retries publication without rerunning the coding agent", () => {
  assert.equal(nextRunAction(state("publish_pending")), "publish");
});

test("reruns legacy publish-pending state that has no immutable artifact", () => {
  assert.equal(nextRunAction(state("publish_pending", undefined, null)), "run");
});

test("repairs labels for a persisted finished run", () => {
  assert.equal(nextRunAction(state("finished", "https://github.com/acme/service/pull/1")), "finalize");
  assert.equal(nextRunAction(state("finished")), "publish");
});

test("runs the agent for new and human-resumed work", () => {
  assert.equal(nextRunAction(), "run");
  assert.equal(nextRunAction(state("awaiting_human")), "run");
  assert.equal(nextRunAction({
    ...state("running", undefined, null),
    awaitingAction: "resume_child",
    pendingHumanReply: "Use PostgreSQL",
    lastSessionId: "ses_worker_12345678",
    workspace: "/data/runs/issue-42/run-abc",
    baseSha: "a".repeat(40),
  }), "resume");
});

test("retains a stale artifact for audit but clears the active reference for a fresh rerun", () => {
  const pending = state("publish_pending");
  const recovered = recoverStalePublication(pending, new Date(0).toISOString());

  assert.equal(recovered.status, "awaiting_human");
  assert.match(recovered.branch, /^opencode\/issue-42-retry-fresh-/);
  assert.notEqual(recovered.branch, pending.branch);
  assert.equal(recovered.publicationArtifact, undefined);
  assert.deepEqual(recovered.stalePublicationArtifacts, [{
    artifact: pending.publicationArtifact,
    detectedAt: new Date(0).toISOString(),
    reason: "base_changed",
  }]);
  assert.equal(nextRunAction({ ...recovered, updatedAt: new Date(0).toISOString() }), "run");
});

test("loads legacy array state and migrates the next write without changing Issue records", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateDirectory = path.join(dataDir, "state");
  await fs.mkdir(stateDirectory);
  await fs.writeFile(path.join(stateDirectory, "runs.json"), `${JSON.stringify([state("failed")])}\n`);
  const store = new StateStore(dataDir);

  await store.load();
  assert.equal((await fs.stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal(store.get(42)?.status, "failed");
  await store.set({ issueNumber: 43, branch: "opencode/issue-43-new", status: "running" });

  const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "runs.json"), "utf8"));
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.runs.length, 2);
  assert.deepEqual(persisted.mergeOperations, []);
  assert.deepEqual(
    persisted.runs.find((run: IssueRunState) => run.issueNumber === 42),
    JSON.parse(JSON.stringify(state("failed"))),
  );
  assert.equal((await fs.stat(path.join(stateDirectory, "runs.json"))).mode & 0o777, 0o600);
});

test("migrates the current schema v2 envelope with all Issue records intact", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-v2-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateDirectory = path.join(dataDir, "state");
  await fs.mkdir(stateDirectory);
  const existing = {
    ...state("finished", "https://github.example/acme/service/pull/42"),
    parentSessionId: "ses_parent_12345678",
  };
  await fs.writeFile(path.join(stateDirectory, "runs.json"), `${JSON.stringify({
    schemaVersion: 2,
    runs: [existing],
  })}\n`);

  const store = new StateStore(dataDir);
  await store.load();
  await store.set({ issueNumber: 43, branch: "opencode/issue-43-new", status: "running" });

  const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "runs.json"), "utf8"));
  assert.equal(persisted.schemaVersion, 3);
  assert.deepEqual(persisted.runs.find((run: IssueRunState) => run.issueNumber === 42), existing);
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

  const persisted = JSON.parse(
    await fs.readFile(path.join(dataDir, "state", "runs.json"), "utf8"),
  );
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.runs.length, 20);
  await assert.rejects(fs.access(path.join(dataDir, "state", "runs.json.tmp")));
});

test("persists the parent and worker OpenCode session relationship", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-sessions-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();

  await store.set({
    issueNumber: 57,
    branch: "opencode/issue-57-login",
    status: "running",
    parentSessionId: "ses_parent_12345678",
    lastSessionId: "ses_worker_12345678",
    workspace: "/opt/issue-harness/data/runs/issue-57/run-abc",
    baseSha: "a".repeat(40),
    awaitingAction: "resume_child",
    pendingHumanReply: "Use PostgreSQL",
    humanQuestionCommentId: 9001,
    humanLatestCommentId: 9002,
    humanCommentResumeAfter: "2026-08-03T10:03:00.000Z",
  });

  const reloaded = new StateStore(dataDir);
  await reloaded.load();
  assert.equal(reloaded.get(57)?.parentSessionId, "ses_parent_12345678");
  assert.equal(reloaded.get(57)?.lastSessionId, "ses_worker_12345678");
  assert.equal(reloaded.getByParentSession("ses_parent_12345678")?.issueNumber, 57);
  assert.equal(reloaded.get(57)?.pendingHumanReply, "Use PostgreSQL");
  assert.equal(reloaded.get(57)?.humanQuestionCommentId, 9001);
  assert.equal(reloaded.get(57)?.humanLatestCommentId, 9002);
  assert.equal(reloaded.get(57)?.humanCommentResumeAfter, "2026-08-03T10:03:00.000Z");
});

test("rejects malformed durable GitHub comment debounce state", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-invalid-comments-"));
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
    issueNumber: 59,
    branch: "opencode/issue-59-comments",
    status: "awaiting_human",
    humanQuestionCommentId: 9001,
    humanLatestCommentId: 9002,
    humanCommentResumeAfter: "not-a-date",
  } as never), /human comment resume/i);
});

test("rejects malformed OpenCode session identifiers in durable state", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-invalid-session-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();

  await assert.rejects(
    store.set({
      issueNumber: 58,
      branch: "opencode/issue-58-login",
      status: "running",
      parentSessionId: "../../secret",
    }),
    /Invalid OpenCode session ID/,
  );
});

test("refuses an ambiguous human answer target when two unfinished Issues share one parent", () => {
  const parentSessionId = "ses_parent_12345678";
  assert.throws(() => activeRunForParent([
    { ...state("running"), issueNumber: 57, parentSessionId },
    { ...state("awaiting_human"), issueNumber: 58, parentSessionId },
  ], parentSessionId), /multiple unfinished Issues/i);
});

test("looks up one completed Issue exactly and rejects an ambiguous parent-only lookup", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-completed-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();
  const parentSessionId = "ses_parent_12345678";

  await store.set({
    issueNumber: 41,
    branch: "opencode/issue-41-first",
    status: "finished",
    parentSessionId,
    prNumber: 71,
    prUrl: "https://github.example/acme/service/pull/71",
    prHeadSha: "a".repeat(40),
  });
  await store.set({
    issueNumber: 42,
    branch: "opencode/issue-42-second",
    status: "finished",
    parentSessionId,
    prNumber: 72,
    prUrl: "https://github.example/acme/service/pull/72",
    prHeadSha: "b".repeat(40),
  });

  assert.equal(store.getCompletedIssue(parentSessionId, 42)?.prNumber, 72);
  assert.equal(store.getCompletedIssue(parentSessionId, 999), undefined);
  assert.throws(() => store.getCompletedIssue(parentSessionId), /multiple completed Issues/i);
});

test("returns eligible unmerged Harness pull request candidates and persists merge metadata", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-prs-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const parentSessionId = "ses_parent_12345678";
  const store = new StateStore(dataDir);
  await store.load();

  await store.set({
    issueNumber: 41,
    branch: "opencode/issue-41-open",
    status: "finished",
    parentSessionId,
    prNumber: 71,
    prUrl: "https://github.example/acme/service/pull/71",
    prHeadSha: "a".repeat(40),
  });
  await store.set({
    issueNumber: 42,
    branch: "opencode/issue-42-merged",
    status: "finished",
    parentSessionId,
    prNumber: 72,
    prUrl: "https://github.example/acme/service/pull/72",
    prHeadSha: "b".repeat(40),
    prMergedAt: "2026-08-03T10:05:00.000Z",
    prMergeSha: "c".repeat(40),
  });

  assert.deepEqual(store.getEligibleStagePullRequestCandidates(parentSessionId), [{
    prNumber: 71,
    issueNumber: 41,
    sessionId: parentSessionId,
    headSha: "a".repeat(40),
    baseBranch: "stage",
    state: "open",
  }]);

  const reloaded = new StateStore(dataDir);
  await reloaded.load();
  assert.equal(reloaded.get(42)?.prMergedAt, "2026-08-03T10:05:00.000Z");
  assert.equal(reloaded.get(42)?.prMergeSha, "c".repeat(40));
  const persisted = await fs.readFile(path.join(dataDir, "state", "runs.json"), "utf8");
  assert.doesNotMatch(persisted, /token|password|private.?key/i);
});

test("serializes identical concurrent claims and fsyncs exactly one transition", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-claim-race-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();
  const operationKey = productionOperationKey("abc1234");

  const results = await Promise.all([
    store.claimMergeOperation({
      operationKey,
      target: "prod",
      stageSha: "abc1234",
      issueNumber: 42,
      actor: "worker-1",
      at: "2026-08-03T10:00:00.000Z",
    }),
    store.claimMergeOperation({
      operationKey,
      target: "prod",
      stageSha: "abc1234",
      issueNumber: 42,
      actor: "worker-2",
      at: "2026-08-03T10:00:01.000Z",
    }),
  ]);

  assert.equal(results.filter((result) => result.kind === "transitioned").length, 1);
  assert.equal(results.filter((result) => result.kind === "replay").length, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "state", "runs.json"), "utf8"));
  assert.equal(persisted.mergeOperations.length, 1);
  assert.equal(persisted.mergeOperations[0].status, "claimed");
});

test("allows distinct merge operation keys to be claimed independently", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-distinct-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();

  const results = await Promise.all([11, 12].map((prNumber, index) => store.claimMergeOperation({
    operationKey: mergeOperationKey({
      target: "stage",
      stageSha: `${index + 1}`.repeat(7),
      prNumber,
      issueNumber: 40 + index,
    }),
    target: "stage",
    stageSha: `${index + 1}`.repeat(7),
    issueNumber: 40 + index,
    prNumber,
    actor: `worker-${index + 1}`,
    at: `2026-08-03T10:00:0${index}.000Z`,
  })));

  assert.deepEqual(results.map((result) => result.kind), ["transitioned", "transitioned"]);
  assert.equal(store.listRecoverableMergeOperations().length, 2);
});

test("recovers claimed and running operations after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-recovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();
  const claimedKey = productionOperationKey("abc1234");
  const runningKey = mergeOperationKey({ target: "stage", stageSha: "def5678", prNumber: 72, issueNumber: 42 });
  await store.claimMergeOperation({ operationKey: claimedKey, target: "prod", stageSha: "abc1234", actor: "worker-1", at: "2026-08-03T10:00:00.000Z" });
  await store.claimMergeOperation({ operationKey: runningKey, target: "stage", stageSha: "def5678", prNumber: 72, issueNumber: 42, actor: "worker-2", at: "2026-08-03T10:00:01.000Z" });
  await store.startMergeOperation(runningKey, { actor: "worker-2", at: "2026-08-03T10:00:02.000Z" });

  const reloaded = new StateStore(dataDir);
  await reloaded.load();
  assert.deepEqual(
    reloaded.listRecoverableMergeOperations().map((operation) => [operation.key, operation.status]),
    [[claimedKey, "claimed"], [runningKey, "running"]],
  );
});

test("replays a succeeded merge after restart instead of transitioning again", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-replay-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const operationKey = productionOperationKey("abc1234");
  const store = new StateStore(dataDir);
  await store.load();
  await store.claimMergeOperation({ operationKey, target: "prod", stageSha: "abc1234", actor: "worker-1", at: "2026-08-03T10:00:00.000Z" });
  await store.startMergeOperation(operationKey, { actor: "worker-1", at: "2026-08-03T10:00:01.000Z" });
  await store.succeedMergeOperation(operationKey, {
    actor: "worker-1",
    at: "2026-08-03T10:00:02.000Z",
    mergeSha: "def5678",
    pullRequestNumber: 81,
    url: "https://github.example/acme/service/pull/81",
  });

  const reloaded = new StateStore(dataDir);
  await reloaded.load();
  const replay = await reloaded.claimMergeOperation({ operationKey, target: "prod", stageSha: "abc1234", actor: "worker-2", at: "2026-08-03T10:00:03.000Z" });
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") assert.equal(replay.replay.kind, "already-merged");
});

test("bounds persisted merge operation records while retaining the newest audit results", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-bounded-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateDirectory = path.join(dataDir, "state");
  await fs.mkdir(stateDirectory);
  const mergeOperations = Array.from({ length: MAX_MERGE_OPERATION_RECORDS + 5 }, (_, index) => (
    succeededMergeOperation(`abc${String(index).padStart(4, "0")}`, index + 1, index)
  ));
  await fs.writeFile(path.join(stateDirectory, "runs.json"), `${JSON.stringify({
    schemaVersion: 3,
    runs: [],
    mergeOperations,
  })}\n`);

  const store = new StateStore(dataDir);
  await store.load();
  await store.set({ issueNumber: 1, branch: "opencode/issue-1-trigger", status: "running" });

  const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "runs.json"), "utf8"));
  assert.equal(persisted.mergeOperations.length, MAX_MERGE_OPERATION_RECORDS);
  assert.equal(persisted.mergeOperations.at(-1).result.pullRequestNumber, MAX_MERGE_OPERATION_RECORDS + 5);
});

function succeededMergeOperation(stageSha: string, pullRequestNumber: number, second: number): MergeOperation {
  const operationKey = productionOperationKey(stageSha);
  const baseTime = Date.UTC(2026, 7, 3, 10, 0, second * 3);
  const claimed = reduceMergeOperation(undefined, {
    type: "claim",
    operationKey,
    target: "prod",
    stageSha,
    actor: "worker-1",
    at: new Date(baseTime).toISOString(),
  });
  assert.equal(claimed.kind, "transitioned");
  if (claimed.kind !== "transitioned") throw new Error("claim failed");
  const running = reduceMergeOperation(claimed.operation, {
    type: "start",
    actor: "worker-1",
    at: new Date(baseTime + 1_000).toISOString(),
  });
  assert.equal(running.kind, "transitioned");
  if (running.kind !== "transitioned") throw new Error("start failed");
  const succeeded = reduceMergeOperation(running.operation, {
    type: "succeed",
    actor: "worker-1",
    at: new Date(baseTime + 2_000).toISOString(),
    mergeSha: `def${String(second).padStart(4, "0")}`,
    pullRequestNumber,
  });
  assert.equal(succeeded.kind, "transitioned");
  if (succeeded.kind !== "transitioned") throw new Error("success failed");
  return succeeded.operation;
}
