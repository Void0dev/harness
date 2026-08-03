import assert from "node:assert/strict";
import test from "node:test";
import {
  isMergeCommandPayload,
  nativeMergePlan,
  persistedMessageId,
} from "../lib/native-merge-command.mjs";

test("builds a no-reply persisted command for explicit merge requests", () => {
  const plan = nativeMergePlan({
    method: "POST",
    pathname: "/session/ses_parent_12345678/command",
    search: "?directory=%2Fworkspace",
    body: {
      command: "merge",
      arguments: "stage #42",
      messageID: "msg_user_12345678",
      agent: "chat",
    },
  });

  assert.equal(plan.commandText, "/merge stage #42");
  assert.equal(plan.sessionID, "ses_parent_12345678");
  assert.equal(plan.upstreamPath, "/session/ses_parent_12345678/message?directory=%2Fworkspace");
  assert.deepEqual(plan.promptBody.parts, [{ type: "text", text: "/merge stage #42" }]);
  assert.equal(plan.promptBody.noReply, true);
});

test("does not treat generated text or another command as a merge request", () => {
  assert.equal(nativeMergePlan({
    method: "POST",
    pathname: "/session/ses_parent_12345678/message",
    body: { command: "merge", arguments: "stage" },
  }), undefined);
  assert.equal(nativeMergePlan({
    method: "POST",
    pathname: "/session/ses_parent_12345678/command",
    body: { command: "issue", arguments: "merge stage" },
  }), undefined);
  assert.equal(isMergeCommandPayload({ command: "merge" }), true);
  assert.equal(isMergeCommandPayload({ command: "issue" }), false);
});

test("extracts only a valid persisted OpenCode user message id", () => {
  assert.equal(persistedMessageId({
    status: 200,
    body: Buffer.from('{"info":{"id":"msg_user_12345678"}}'),
  }), "msg_user_12345678");
  assert.equal(persistedMessageId({ status: 500, body: Buffer.alloc(0) }), undefined);
  assert.equal(persistedMessageId({ status: 200, body: Buffer.from("not-json") }), undefined);
});
