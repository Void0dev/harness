import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptsHumanAnswer,
  acceptsTechnicalRetry,
  sanitizeTaskView,
  taskViewsForParent,
  technicalRetryTransition,
  workerSessionDirectory,
} from "../src/task-view.js";

test("sanitizes a durable task view without exposing unknown fields", () => {
  const view = sanitizeTaskView({
    schemaVersion: 1,
    issueNumber: 57,
    title: "Fix login",
    issueUrl: "https://github.com/acme/service/issues/57",
    status: "finished",
    stages: ["accepted", "studying", "coding", "testing", "publishing"],
    summary: "Added validation and tests.",
    files: [{ path: "src/login.ts", additions: 12, deletions: 3 }],
    workerSessionPath: "/project/session/ses_worker_12345678",
    prUrl: "https://github.com/acme/service/pull/83",
    modelId: "gpt-5.5",
    generationStartedAt: "2026-07-28T09:58:19.000Z",
    generationCompletedAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    secret: "must-not-survive",
  });

  assert.deepEqual(view, {
    schemaVersion: 1,
    issueNumber: 57,
    title: "Fix login",
    issueUrl: "https://github.com/acme/service/issues/57",
    status: "finished",
    stages: ["accepted", "studying", "coding", "testing", "publishing"],
    summary: "Added validation and tests.",
    files: [{ path: "src/login.ts", additions: 12, deletions: 3 }],
    workerSessionPath: "/project/session/ses_worker_12345678",
    prUrl: "https://github.com/acme/service/pull/83",
    modelId: "gpt-5.5",
    generationStartedAt: "2026-07-28T09:58:19.000Z",
    generationCompletedAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
  });
});

test("rejects unsafe task view text and file paths", () => {
  assert.throws(() => sanitizeTaskView({
    schemaVersion: 1,
    issueNumber: 1,
    title: "x",
    status: "running",
    stages: ["accepted"],
    files: [{ path: "../secret" }],
    updatedAt: "2026-07-28T10:00:00.000Z",
  }), /file path/i);
});

test("returns only cards belonging to the requested parent session", () => {
  const common = {
    branch: "opencode/issue-test",
    status: "running" as const,
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
  const states = [
    {
      ...common,
      issueNumber: 1,
      parentSessionId: "ses_parent_12345678",
      taskView: sanitizeTaskView({
        schemaVersion: 1,
        issueNumber: 1,
        title: "First",
        status: "running",
        stages: ["accepted"],
        updatedAt: common.updatedAt,
      }),
    },
    {
      ...common,
      issueNumber: 2,
      parentSessionId: "ses_other_12345678",
      taskView: sanitizeTaskView({
        schemaVersion: 1,
        issueNumber: 2,
        title: "Other",
        status: "running",
        stages: ["accepted"],
        updatedAt: common.updatedAt,
      }),
    },
  ];

  assert.deepEqual(taskViewsForParent(states, "ses_parent_12345678").map((view) => view.issueNumber), [1]);
});

test("represents a newly created Issue as queued before the worker claims it", () => {
  const queued = sanitizeTaskView({
    schemaVersion: 1,
    issueNumber: 3,
    title: "Queued feature",
    status: "queued",
    stages: ["accepted"],
    updatedAt: "2026-07-28T10:00:00.000Z",
  });
  assert.equal(queued.status, "queued");
});

test("accepts ordinary chat replies only for a real pending human question", () => {
  assert.equal(acceptsHumanAnswer({
    status: "awaiting_human",
    taskView: sanitizeTaskView({
      schemaVersion: 1,
      issueNumber: 7,
      title: "Choose storage",
      status: "awaiting_human",
      stages: ["accepted", "studying"],
      question: "PostgreSQL or SQLite?",
      updatedAt: "2026-07-28T10:00:00.000Z",
    }),
  }), true);
  assert.equal(acceptsHumanAnswer({
    status: "awaiting_human",
    taskView: sanitizeTaskView({
      schemaVersion: 1,
      issueNumber: 8,
      title: "Network failure",
      status: "failed",
      stages: ["accepted", "studying"],
      question: "Retry later",
      updatedAt: "2026-07-28T10:00:00.000Z",
    }),
  }), false);
});

test("accepts an explicit retry only for a recoverable technical failure", () => {
  const failed = sanitizeTaskView({
    schemaVersion: 1,
    issueNumber: 8,
    title: "Network failure",
    status: "failed",
    stages: ["accepted", "studying"],
    question: "OpenCode is unavailable",
    updatedAt: "2026-07-28T10:00:00.000Z",
  });
  assert.equal(acceptsTechnicalRetry({ status: "awaiting_human", awaitingAction: "rerun", taskView: failed }), true);
  assert.equal(acceptsTechnicalRetry({ status: "awaiting_human", taskView: failed }), false);
  assert.equal(acceptsTechnicalRetry({ status: "running", awaitingAction: "rerun", taskView: failed }), false);
});

test("technical retry resumes the child session when one is available", () => {
  const failed = {
    issueNumber: 8,
    branch: "opencode/issue-8-network-failure",
    status: "awaiting_human" as const,
    awaitingAction: "resume_child" as const,
    lastSessionId: "ses_worker_12345678",
    workspace: "C:\\runs\\issue-8",
    baseSha: "a".repeat(40),
  };

  assert.deepEqual(technicalRetryTransition(failed, ""), {
    ...failed,
    status: "running",
    pendingHumanReply: "Retry the interrupted operation after the reported technical failure.",
  });
  assert.deepEqual(technicalRetryTransition(failed, "Исправь также тест"), {
    ...failed,
    status: "running",
    awaitingAction: "resume_child",
    pendingHumanReply: "Исправь также тест",
  });
});

test("recovers worker metadata through the child workspace directory", () => {
  assert.equal(workerSessionDirectory({ workspace: "/runs/issue-57/run-abc" }, "/context"), "/runs/issue-57/run-abc");
  assert.equal(workerSessionDirectory({}, "/context"), "/context");
});
