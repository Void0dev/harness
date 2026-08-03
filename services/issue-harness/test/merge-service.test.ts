import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MergeService } from "../src/merge-service.js";
import { StateStore } from "../src/state.js";

async function stateFixture(t: test.TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-merge-service-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const state = new StateStore(dataDir);
  await state.load();
  return state;
}

async function finishedRun(state: StateStore, issueNumber: number, parentSessionId: string, prNumber: number) {
  await state.set({
    issueNumber,
    branch: `opencode/issue-${issueNumber}`,
    status: "finished",
    parentSessionId,
    prNumber,
    prUrl: `https://github.example/pull/${prNumber}`,
    prHeadSha: `${issueNumber}`.repeat(40).slice(0, 40),
  });
}

test("merges one explicit stage candidate and persists replay metadata", async (t) => {
  const state = await stateFixture(t);
  await finishedRun(state, 4, "ses_parent_12345678", 81);
  const calls: string[] = [];
  const github = {
    findHarnessPullRequest: async () => null,
    markStagePullRequestReady: async () => { calls.push("ready"); return { kind: "ready", pullRequestNumber: 81, url: "https://github.example/pull/81" } as const; },
    mergeStagePullRequest: async () => { calls.push("merge-stage"); return { kind: "merged", pullRequestNumber: 81, url: "https://github.example/pull/81", mergeSha: "a".repeat(40) } as const; },
    readReleaseHeads: async () => ({ stageSha: "a".repeat(40), mainSha: "b".repeat(40) }),
    findOrCreatePromotionPullRequest: async () => { throw new Error("unexpected"); },
    mergePromotionPullRequest: async () => { throw new Error("unexpected"); },
    inspectPullRequest: async () => { throw new Error("unexpected"); },
  };
  const service = new MergeService(state, github, tickingClock());

  const result = await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "stage #4",
    requestedBy: "developer",
  });

  assert.deepEqual(result, {
    status: "merged",
    target: "stage",
    pullRequestNumber: 81,
    mergeSha: "a".repeat(40),
    url: "https://github.example/pull/81",
  });
  assert.deepEqual(calls, ["ready", "merge-stage"]);
  assert.equal(state.get(4)?.prMergeSha, "a".repeat(40));
  assert.equal(state.allMergeOperations()[0].status, "succeeded");
});

test("requires an Issue selector when a parent session has multiple stage candidates", async (t) => {
  const state = await stateFixture(t);
  await finishedRun(state, 4, "ses_parent_12345678", 81);
  await finishedRun(state, 5, "ses_parent_12345678", 82);
  const service = new MergeService(state, unusedGithub(), tickingClock());

  assert.deepEqual(await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "stage",
    requestedBy: "developer",
  }), {
    status: "ambiguous",
    target: "stage",
    candidates: [{ issueNumber: 4, prNumber: 81 }, { issueNumber: 5, prNumber: 82 }],
  });
});

test("promotes production only through a stage to main pull request", async (t) => {
  const state = await stateFixture(t);
  const calls: string[] = [];
  const promotion = {
    number: 92,
    url: "https://github.example/pull/92",
    state: "open",
    draft: false,
    merged: false,
    headBranch: "stage",
    headSha: "c".repeat(40),
    baseBranch: "main",
    baseSha: "d".repeat(40),
  } as const;
  const github = {
    ...unusedGithub(),
    readReleaseHeads: async () => ({ stageSha: "c".repeat(40), mainSha: "d".repeat(40) }),
    findOrCreatePromotionPullRequest: async () => { calls.push("stage-to-main-pr"); return { kind: "created", pullRequest: promotion, stageSha: promotion.headSha, mainSha: promotion.baseSha } as const; },
    mergePromotionPullRequest: async () => { calls.push("merge-promotion"); return { kind: "merged", pullRequestNumber: 92, url: promotion.url, mergeSha: "e".repeat(40) } as const; },
  };
  const service = new MergeService(state, github, tickingClock());

  const result = await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "prod",
    requestedBy: "developer",
  });

  assert.equal(result.status, "merged");
  assert.equal(result.target, "prod");
  assert.deepEqual(calls, ["stage-to-main-pr", "merge-promotion"]);
});

test("rejects production Issue selectors before any GitHub side effect", async (t) => {
  const state = await stateFixture(t);
  const service = new MergeService(state, unusedGithub(), tickingClock());
  const result = await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "prod #4",
    requestedBy: "developer",
  });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /does not accept/);
});

test("recovers a remotely merged operation that stopped after claim", async (t) => {
  const state = await stateFixture(t);
  await finishedRun(state, 4, "ses_parent_12345678", 81);
  const operationKey = "merge:stage:4:81:4444444444444444444444444444444444444444";
  await state.claimMergeOperation({
    operationKey,
    target: "stage",
    stageSha: "4".repeat(40),
    issueNumber: 4,
    prNumber: 81,
    actor: "developer",
    at: "2026-08-03T11:59:59.000Z",
  });
  const github = {
    ...unusedGithub(),
    inspectPullRequest: async () => ({
      readiness: "already-merged",
      mergeCommitSha: "a".repeat(40),
      pullRequest: {
        number: 81,
        url: "https://github.example/pull/81",
        state: "closed",
        draft: false,
        merged: true,
        headBranch: "opencode/issue-4",
        headSha: "4".repeat(40),
        baseBranch: "stage",
        baseSha: "b".repeat(40),
      },
    } as const),
  };
  const service = new MergeService(state, github, tickingClock());

  await service.recoverIncompleteOperations();

  assert.equal(state.getMergeOperation(operationKey)?.status, "succeeded");
  assert.equal(state.get(4)?.prMergeSha, "a".repeat(40));
});

test("persists the production pull request number before merge for crash recovery", async (t) => {
  const state = await stateFixture(t);
  const promotion = {
    number: 92,
    url: "https://github.example/pull/92",
    state: "open",
    draft: false,
    merged: false,
    headBranch: "stage",
    headSha: "c".repeat(40),
    baseBranch: "main",
    baseSha: "d".repeat(40),
  } as const;
  const github = {
    ...unusedGithub(),
    readReleaseHeads: async () => ({ stageSha: promotion.headSha, mainSha: promotion.baseSha }),
    findOrCreatePromotionPullRequest: async () => ({
      kind: "created",
      pullRequest: promotion,
      stageSha: promotion.headSha,
      mainSha: promotion.baseSha,
    } as const),
    mergePromotionPullRequest: async () => {
      throw new Error("simulated crash before merge response");
    },
  };
  const service = new MergeService(state, github, tickingClock());

  const result = await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "prod",
    requestedBy: "developer",
  });

  assert.equal(result.status, "failed");
  assert.equal(state.allMergeOperations()[0]?.prNumber, 92);

  const recovery = new MergeService(state, {
    ...unusedGithub(),
    inspectPullRequest: async () => ({
      readiness: "already-merged",
      mergeCommitSha: "e".repeat(40),
      pullRequest: { ...promotion, state: "closed", merged: true },
    } as const),
  }, () => "2026-08-03T12:01:00.000Z");
  await recovery.recoverIncompleteOperations();
  assert.equal(state.allMergeOperations()[0]?.status, "succeeded");
});

test("allows a blocked stage merge to retry after the pull request head advances", async (t) => {
  const state = await stateFixture(t);
  await finishedRun(state, 4, "ses_parent_12345678", 81);
  let mergeAttempt = 0;
  const github = {
    ...unusedGithub(),
    markStagePullRequestReady: async () => ({
      kind: "already-ready",
      pullRequestNumber: 81,
      url: "https://github.example/pull/81",
    } as const),
    mergeStagePullRequest: async () => {
      mergeAttempt += 1;
      return mergeAttempt === 1
        ? { kind: "blocked", pullRequestNumber: 81, url: "https://github.example/pull/81", reason: "checks pending" } as const
        : { kind: "merged", pullRequestNumber: 81, url: "https://github.example/pull/81", mergeSha: "a".repeat(40) } as const;
    },
  };
  const service = new MergeService(state, github, tickingClock());

  const blocked = await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "stage #4",
    requestedBy: "developer",
  });
  assert.equal(blocked.status, "blocked");

  const current = state.get(4);
  if (!current) throw new Error("missing finished run");
  const { updatedAt: _updatedAt, ...persisted } = current;
  await state.set({ ...persisted, prHeadSha: "f".repeat(40) });

  const merged = await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "stage #4",
    requestedBy: "developer",
  });

  assert.equal(merged.status, "merged");
  assert.deepEqual(state.allMergeOperations().map((operation) => operation.status), ["retryable", "succeeded"]);
});

test("rebinds a retryable production operation to a replacement pull request", async (t) => {
  const state = await stateFixture(t);
  const stageSha = "c".repeat(40);
  const operationKey = `merge:prod:${stageSha}`;
  await state.claimMergeOperation({
    operationKey,
    target: "prod",
    stageSha,
    prNumber: 91,
    actor: "developer",
    at: "2026-08-03T11:58:00.000Z",
  });
  await state.startMergeOperation(operationKey, {
    actor: "developer",
    at: "2026-08-03T11:58:01.000Z",
  });
  await state.retryMergeOperation(operationKey, {
    actor: "developer",
    at: "2026-08-03T11:58:02.000Z",
    reason: "Original promotion pull request was closed",
  });
  const replacement = {
    number: 92,
    url: "https://github.example/pull/92",
    state: "open",
    draft: false,
    merged: false,
    headBranch: "stage",
    headSha: stageSha,
    baseBranch: "main",
    baseSha: "d".repeat(40),
  } as const;
  const service = new MergeService(state, {
    ...unusedGithub(),
    findOrCreatePromotionPullRequest: async () => ({
      kind: "created",
      pullRequest: replacement,
      stageSha,
      mainSha: replacement.baseSha,
    } as const),
    mergePromotionPullRequest: async () => {
      throw new Error("simulated crash after replacement PR selection");
    },
  }, tickingClock());

  assert.equal((await service.submit({
    parentSessionId: "ses_parent_12345678",
    argumentsText: "prod",
    requestedBy: "developer",
  })).status, "failed");
  assert.equal(state.getMergeOperation(operationKey)?.prNumber, 92);

  const recovery = new MergeService(state, {
    ...unusedGithub(),
    inspectPullRequest: async (pullNumber) => {
      assert.equal(pullNumber, 92);
      return {
        readiness: "already-merged",
        mergeCommitSha: "e".repeat(40),
        pullRequest: { ...replacement, state: "closed", merged: true },
      } as const;
    },
  }, () => "2026-08-03T12:01:00.000Z");
  await recovery.recoverIncompleteOperations();
  assert.equal(state.getMergeOperation(operationKey)?.status, "succeeded");
});

function tickingClock() {
  let second = 0;
  return () => `2026-08-03T12:00:${String(second++).padStart(2, "0")}.000Z`;
}

function unusedGithub() {
  const unexpected = async () => { throw new Error("unexpected GitHub call"); };
  return {
    findHarnessPullRequest: unexpected,
    markStagePullRequestReady: unexpected,
    mergeStagePullRequest: unexpected,
    readReleaseHeads: unexpected,
    findOrCreatePromotionPullRequest: unexpected,
    mergePromotionPullRequest: unexpected,
    inspectPullRequest: unexpected,
  };
}
