import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAgentRunComplete,
  assertDraftPullRequestMatchesRun,
  hasHumanAttention,
  humanAttentionQuestion,
} from "../src/completion.js";

test("refuses a committed run without the completion signal", () => {
  assert.throws(
    () => assertAgentRunComplete({ stdout: "partial", hasBranchCommits: true, worktreeClean: true }),
    /required completion signal/,
  );
});

test("accepts completion backed by an existing ahead commit", () => {
  assert.doesNotThrow(() => assertAgentRunComplete({
    stdout: "done <promise>COMPLETE</promise>",
    completionSignal: "<promise>COMPLETE</promise>",
    hasBranchCommits: true,
    worktreeClean: true,
  }));
});

test("refuses completion on an empty branch", () => {
  assert.throws(
    () => assertAgentRunComplete({
      stdout: "done <promise>COMPLETE</promise>",
      completionSignal: "<promise>COMPLETE</promise>",
      hasBranchCommits: false,
      worktreeClean: true,
    }),
    /empty branch/,
  );
});

test("allows a human-attention response without completion", () => {
  const stdout = "<human-attention>Which API contract applies?</human-attention>";
  assert.equal(hasHumanAttention(stdout), true);
  assert.doesNotThrow(() => assertAgentRunComplete({ stdout, hasBranchCommits: false, worktreeClean: false }));
});

test("refuses completion with uncommitted work", () => {
  assert.throws(() => assertAgentRunComplete({
    stdout: "done <promise>COMPLETE</promise>",
    completionSignal: "<promise>COMPLETE</promise>",
    hasBranchCommits: true,
    worktreeClean: false,
  }), /uncommitted/i);
});

test("requires the draft pull request to point at the exact completed branch head", () => {
  const pullRequest = {
    number: 83,
    url: "https://github.com/acme/service/pull/83",
    state: "open" as const,
    draft: true,
    merged: false,
    headBranch: "opencode/issue-57-login",
    headSha: "b".repeat(40),
    baseBranch: "stage",
    baseSha: "a".repeat(40),
  };
  assert.doesNotThrow(() => assertDraftPullRequestMatchesRun({
    pullRequest,
    branch: "opencode/issue-57-login",
    headSha: "b".repeat(40),
    baseBranch: "stage",
  }));
  assert.throws(() => assertDraftPullRequestMatchesRun({
    pullRequest,
    branch: "opencode/issue-57-login",
    headSha: "c".repeat(40),
    baseBranch: "stage",
  }), /head SHA/i);
});

test("does not expose raw human-attention contents", () => {
  const moduleSource = hasHumanAttention.toString();
  assert.doesNotMatch(moduleSource, /return\s+match\?\./);
  assert.equal(hasHumanAttention("<human-attention>upstream-secret</human-attention>"), true);
});

test("extracts a bounded human question for the parent chat", () => {
  assert.equal(
    humanAttentionQuestion("before <human-attention> Which database should I use? </human-attention> after"),
    "Which database should I use?",
  );
  assert.equal(humanAttentionQuestion(`<human-attention>${"x".repeat(5_000)}</human-attention>`)?.length, 4_000);
  assert.equal(humanAttentionQuestion("<human-attention>   </human-attention>"), undefined);
});
