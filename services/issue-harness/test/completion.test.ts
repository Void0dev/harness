import assert from "node:assert/strict";
import test from "node:test";
import { assertAgentRunPublishable, extractHumanQuestion } from "../src/completion.js";

test("refuses a committed run without the completion signal", () => {
  assert.throws(
    () => assertAgentRunPublishable({ stdout: "partial", hasBranchCommits: true }),
    /required completion signal/,
  );
});

test("accepts completion backed by an existing ahead commit", () => {
  assert.doesNotThrow(() => assertAgentRunPublishable({
    stdout: "done <promise>COMPLETE</promise>",
    completionSignal: "<promise>COMPLETE</promise>",
    hasBranchCommits: true,
  }));
});

test("refuses completion on an empty branch", () => {
  assert.throws(
    () => assertAgentRunPublishable({
      stdout: "done <promise>COMPLETE</promise>",
      completionSignal: "<promise>COMPLETE</promise>",
      hasBranchCommits: false,
    }),
    /empty branch/,
  );
});

test("allows a human-attention response without completion", () => {
  const stdout = "<human-attention>Which API contract applies?</human-attention>";
  assert.equal(extractHumanQuestion(stdout), "Which API contract applies?");
  assert.doesNotThrow(() => assertAgentRunPublishable({ stdout, hasBranchCommits: false }));
});
