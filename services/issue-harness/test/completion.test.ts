import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAgentRunPublishable,
  hasHumanAttention,
  humanAttentionQuestion,
} from "../src/completion.js";

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
  assert.equal(hasHumanAttention(stdout), true);
  assert.doesNotThrow(() => assertAgentRunPublishable({ stdout, hasBranchCommits: false }));
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
