import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MERGE_AUDIT_DETAIL_LENGTH,
  MAX_MERGE_AUDIT_ENTRIES,
  mergeOperationKey,
  mergeReplayResult,
  parseMergeSelection,
  productionOperationKey,
  reduceMergeOperation,
  selectEligibleStagePullRequest,
  type MergeOperation,
} from "../src/merge.js";

const at = (second: number) => `2026-08-03T10:00:${String(second).padStart(2, "0")}.000Z`;

test("parses a merge target with an optional issue selector", () => {
  assert.deepEqual(parseMergeSelection("stage"), { target: "stage" });
  assert.deepEqual(parseMergeSelection("stage #42"), { target: "stage", issueNumber: 42 });
  assert.deepEqual(parseMergeSelection({ target: "stage", issue: 7 }), {
    target: "stage",
    issueNumber: 7,
  });
  assert.deepEqual(parseMergeSelection("prod"), { target: "prod" });
});

test("rejects invalid production issue selectors", () => {
  for (const selector of ["#0", "#-1", "issue-7", "#7x", "1.5", ""]) {
    assert.throws(
      () => parseMergeSelection({ target: "stage", issue: selector }),
      /Invalid issue selector/,
    );
  }
  assert.throws(() => parseMergeSelection("prod #1"), /does not accept an Issue selector/);
  assert.throws(() => parseMergeSelection("prod #1 extra"), /Invalid merge selection/);
});

test("selects exactly one eligible stage pull request from the active session", () => {
  const result = selectEligibleStagePullRequest({
    sessionId: "ses_active_12345678",
    issueNumber: 42,
    candidates: [
      {
        prNumber: 11,
        issueNumber: 42,
        sessionId: "ses_other_12345678",
        headSha: "aaa1111",
        baseBranch: "stage",
        state: "open",
      },
      {
        prNumber: 12,
        issueNumber: 42,
        sessionId: "ses_active_12345678",
        headSha: "bbb2222",
        baseBranch: "stage",
        state: "open",
      },
      {
        prNumber: 13,
        issueNumber: 42,
        sessionId: "ses_active_12345678",
        headSha: "ccc3333",
        baseBranch: "main",
        state: "open",
      },
    ],
  });

  assert.equal(result.kind, "selected");
  if (result.kind === "selected") assert.equal(result.candidate.prNumber, 12);
});

test("reports ambiguity instead of choosing among multiple eligible stage pull requests", () => {
  const result = selectEligibleStagePullRequest({
    sessionId: "ses_active_12345678",
    candidates: [
      { prNumber: 9, issueNumber: 2, sessionId: "ses_active_12345678", headSha: "bbb2222", baseBranch: "stage", state: "open" },
      { prNumber: 3, issueNumber: 1, sessionId: "ses_active_12345678", headSha: "aaa1111", baseBranch: "stage", state: "open" },
    ],
  });

  assert.deepEqual(result, {
    kind: "ambiguous",
    reason: "multiple-eligible-stage-prs",
    candidates: [
      { prNumber: 3, issueNumber: 1, sessionId: "ses_active_12345678", headSha: "aaa1111", baseBranch: "stage", state: "open" },
      { prNumber: 9, issueNumber: 2, sessionId: "ses_active_12345678", headSha: "bbb2222", baseBranch: "stage", state: "open" },
    ],
  });
});

test("builds deterministic operation keys and keys production only by stage SHA", () => {
  assert.equal(productionOperationKey("ABCDEF1234"), "merge:prod:abcdef1234");
  assert.equal(
    mergeOperationKey({ target: "prod", stageSha: "ABCDEF1234", prNumber: 99, issueNumber: 7 }),
    "merge:prod:abcdef1234",
  );
  assert.equal(
    mergeOperationKey({ target: "stage", stageSha: "ABCDEF1234", prNumber: 12, issueNumber: 7 }),
    "merge:stage:7:12:abcdef1234",
  );
  assert.notEqual(
    mergeOperationKey({ target: "stage", stageSha: "ABCDEF1234", prNumber: 12, issueNumber: 7 }),
    mergeOperationKey({ target: "stage", stageSha: "FEDCBA4321", prNumber: 12, issueNumber: 7 }),
  );
});

test("returns an already-merged replay without scheduling another merge", () => {
  const operation = succeededOperation();
  assert.deepEqual(mergeReplayResult(operation), {
    kind: "already-merged",
    operationKey: operation.key,
    mergeSha: "def4567",
    pullRequestNumber: 81,
    url: "https://github.example/pull/81",
  });

  const replay = reduceMergeOperation(operation, {
    type: "claim",
    operationKey: operation.key,
    target: "prod",
    stageSha: "abc1234",
    actor: "worker-2",
    at: at(4),
  });
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") assert.equal(replay.replay.kind, "already-merged");
});

test("allows only one concurrent claim at the pure reducer level", () => {
  const first = reduceMergeOperation(undefined, {
    type: "claim",
    operationKey: productionOperationKey("abc1234"),
    target: "prod",
    stageSha: "abc1234",
    issueNumber: 42,
    actor: "worker-1",
    at: at(0),
  });
  assert.equal(first.kind, "transitioned");
  if (first.kind !== "transitioned") return;

  const second = reduceMergeOperation(first.operation, {
    type: "claim",
    operationKey: first.operation.key,
    target: "prod",
    stageSha: "abc1234",
    issueNumber: 42,
    actor: "worker-2",
    at: at(1),
  });
  assert.equal(second.kind, "replay");
  if (second.kind === "replay") {
    assert.equal(second.replay.kind, "in-progress");
    assert.equal(second.operation.claimant, "worker-1");
  }
});

test("validates claimed, running, retryable, blocked, and succeeded lifecycle transitions", () => {
  const claimed = claimOperation();
  const invalidSuccess = reduceMergeOperation(claimed, {
    type: "succeed",
    actor: "worker-1",
    at: at(1),
    mergeSha: "def4567",
    pullRequestNumber: 81,
  });
  assert.equal(invalidSuccess.kind, "rejected");

  const running = reduceMergeOperation(claimed, { type: "start", actor: "worker-1", at: at(1) });
  assert.equal(running.kind, "transitioned");
  if (running.kind !== "transitioned") return;

  const retryable = reduceMergeOperation(running.operation, {
    type: "retry",
    actor: "worker-1",
    at: at(2),
    reason: "base branch moved",
  });
  assert.equal(retryable.kind, "transitioned");
  if (retryable.kind !== "transitioned") return;
  assert.equal(retryable.operation.status, "retryable");

  const reclaimed = reduceMergeOperation(retryable.operation, {
    type: "claim",
    operationKey: retryable.operation.key,
    target: "prod",
    stageSha: "abc1234",
    actor: "worker-2",
    at: at(3),
  });
  assert.equal(reclaimed.kind, "transitioned");
  if (reclaimed.kind !== "transitioned") return;
  assert.equal(reclaimed.operation.attempt, 2);
  assert.equal(reclaimed.operation.claimant, "worker-2");

  const runningAgain = reduceMergeOperation(reclaimed.operation, { type: "start", actor: "worker-2", at: at(4) });
  assert.equal(runningAgain.kind, "transitioned");
  if (runningAgain.kind !== "transitioned") return;

  const blocked = reduceMergeOperation(runningAgain.operation, {
    type: "block",
    actor: "worker-2",
    at: at(5),
    reason: "required review missing",
  });
  assert.equal(blocked.kind, "transitioned");
  if (blocked.kind !== "transitioned") return;
  assert.equal(blocked.operation.status, "blocked");
  assert.equal(
    reduceMergeOperation(blocked.operation, { type: "start", actor: "worker-2", at: at(6) }).kind,
    "rejected",
  );
});

test("bounds merge audit detail and retained audit history", () => {
  let operation = claimOperation();
  for (let index = 0; index < MAX_MERGE_AUDIT_ENTRIES + 5; index += 1) {
    const retryable = reduceMergeOperation(operation, {
      type: "retry",
      actor: operation.claimant,
      at: new Date(Date.UTC(2026, 7, 3, 11, 0, index * 2)).toISOString(),
      reason: "x".repeat(MAX_MERGE_AUDIT_DETAIL_LENGTH + 500),
    });
    assert.equal(retryable.kind, "transitioned");
    if (retryable.kind !== "transitioned") return;

    const claimed = reduceMergeOperation(retryable.operation, {
      type: "claim",
      operationKey: retryable.operation.key,
      target: retryable.operation.target,
      stageSha: retryable.operation.stageSha,
      actor: "worker-1",
      at: new Date(Date.UTC(2026, 7, 3, 11, 0, index * 2 + 1)).toISOString(),
    });
    assert.equal(claimed.kind, "transitioned");
    if (claimed.kind !== "transitioned") return;
    operation = claimed.operation;
  }

  assert.equal(operation.audit.length, MAX_MERGE_AUDIT_ENTRIES);
  assert.equal(
    Math.max(...operation.audit.map((entry) => entry.detail?.length ?? 0)),
    MAX_MERGE_AUDIT_DETAIL_LENGTH,
  );
});

test("rejects persisted operations with unbounded failure audit data", () => {
  const operation: MergeOperation = {
    ...claimOperation(),
    status: "blocked",
    failureReason: "x".repeat(MAX_MERGE_AUDIT_DETAIL_LENGTH + 1),
  };

  assert.throws(() => mergeReplayResult(operation), /failure reason is too long/);
});

function claimOperation(): MergeOperation {
  const result = reduceMergeOperation(undefined, {
    type: "claim",
    operationKey: productionOperationKey("abc1234"),
    target: "prod",
    stageSha: "abc1234",
    actor: "worker-1",
    at: at(0),
  });
  assert.equal(result.kind, "transitioned");
  if (result.kind !== "transitioned") throw new Error("claim failed");
  return result.operation;
}

function succeededOperation(): MergeOperation {
  const claimed = claimOperation();
  const running = reduceMergeOperation(claimed, { type: "start", actor: "worker-1", at: at(1) });
  assert.equal(running.kind, "transitioned");
  if (running.kind !== "transitioned") throw new Error("start failed");
  const succeeded = reduceMergeOperation(running.operation, {
    type: "succeed",
    actor: "worker-1",
    at: at(2),
    mergeSha: "def4567",
    pullRequestNumber: 81,
    url: "https://github.example/pull/81",
  });
  assert.equal(succeeded.kind, "transitioned");
  if (succeeded.kind !== "transitioned") throw new Error("success failed");
  return succeeded.operation;
}
