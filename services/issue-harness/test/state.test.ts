import assert from "node:assert/strict";
import test from "node:test";
import { nextRunAction, type IssueRunState } from "../src/state.js";

function state(status: IssueRunState["status"], prUrl?: string): IssueRunState {
  return {
    issueNumber: 42,
    branch: "codex/issue-42-retry",
    status,
    prUrl,
    updatedAt: new Date(0).toISOString(),
  };
}

test("retries publication without rerunning the coding agent", () => {
  assert.equal(nextRunAction(state("publish_pending")), "publish");
});

test("repairs labels for a persisted finished run", () => {
  assert.equal(nextRunAction(state("finished", "https://github.com/acme/service/pull/1")), "finalize");
  assert.equal(nextRunAction(state("finished")), "publish");
});

test("runs the agent for new and human-resumed work", () => {
  assert.equal(nextRunAction(), "run");
  assert.equal(nextRunAction(state("awaiting_human")), "run");
});
