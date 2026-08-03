import assert from "node:assert/strict";
import test from "node:test";
import { parseMergeOutcomeRequest } from "../lib/runtime-control.mjs";

test("accepts a bounded merge materialization request", () => {
  const request = {
    parentSessionId: "ses_parent_12345678",
    messageID: "msg_user_12345678",
    commandText: "/merge stage #42",
    outcome: {
      command: "merge",
      status: "merged",
      target: "stage",
      pullRequestNumber: 81,
      mergeSha: "a".repeat(40),
    },
  };
  assert.deepEqual(parseMergeOutcomeRequest(request), request);
});

test("rejects malformed commands and unbounded outcome data", () => {
  const base = {
    parentSessionId: "ses_parent_12345678",
    messageID: "msg_user_12345678",
    commandText: "/merge prod",
    outcome: { command: "merge", status: "blocked", target: "prod" },
  };
  assert.throws(() => parseMergeOutcomeRequest({ ...base, commandText: "/issue merge prod" }), /command text/);
  assert.throws(() => parseMergeOutcomeRequest({
    ...base,
    outcome: { ...base.outcome, reason: "x".repeat(2_001) },
  }), /reason/);
  assert.throws(() => parseMergeOutcomeRequest({
    ...base,
    outcome: { ...base.outcome, mergeSha: "not-a-sha" },
  }), /merge sha/);
});
