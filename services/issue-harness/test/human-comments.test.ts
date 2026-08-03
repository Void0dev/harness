import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHumanCommentWindow } from "../src/human-comments.js";

test("waits three minutes after the latest trusted GitHub comment", () => {
  const questionCommentId = 100;
  const firstComment = {
    id: 101,
    author: "alice",
    body: "Use PostgreSQL.",
    createdAt: "2026-08-03T10:00:00.000Z",
  };
  const observed = evaluateHumanCommentWindow({
    questionCommentId,
    comments: [firstComment],
    now: Date.parse("2026-08-03T10:01:00.000Z"),
  });

  assert.deepEqual(observed, {
    kind: "waiting",
    latestCommentId: 101,
    resumeAfter: "2026-08-03T10:03:00.000Z",
  });

  const secondComment = {
    id: 102,
    author: "alice",
    body: "Do not add a migration yet.",
    createdAt: "2026-08-03T10:02:30.000Z",
  };
  const extended = evaluateHumanCommentWindow({
    questionCommentId,
    latestCommentId: observed.latestCommentId,
    resumeAfter: observed.resumeAfter,
    comments: [firstComment, secondComment],
    now: Date.parse("2026-08-03T10:03:01.000Z"),
  });

  assert.deepEqual(extended, {
    kind: "waiting",
    latestCommentId: 102,
    resumeAfter: "2026-08-03T10:05:30.000Z",
  });

  const ready = evaluateHumanCommentWindow({
    questionCommentId,
    latestCommentId: extended.latestCommentId,
    resumeAfter: extended.resumeAfter,
    comments: [firstComment, secondComment],
    now: Date.parse("2026-08-03T10:05:30.000Z"),
  });

  assert.deepEqual(ready, {
    kind: "resume",
    latestCommentId: 102,
    reply: [
      "GitHub comments from trusted repository collaborators:",
      "",
      "@alice:",
      "Use PostgreSQL.",
      "",
      "---",
      "",
      "@alice:",
      "Do not add a migration yet.",
    ].join("\n"),
  });
});

test("a persisted expired debounce resumes immediately after restart", () => {
  assert.equal(evaluateHumanCommentWindow({
    questionCommentId: 200,
    latestCommentId: 201,
    resumeAfter: "2026-08-03T11:03:00.000Z",
    comments: [{
      id: 201,
      author: "bob",
      body: "Keep the existing API.",
      createdAt: "2026-08-03T11:00:00.000Z",
    }],
    now: Date.parse("2026-08-03T11:04:00.000Z"),
  }).kind, "resume");
});
