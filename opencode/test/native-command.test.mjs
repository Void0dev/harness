import assert from "node:assert/strict";
import test from "node:test";
import { harnessCommandOutcome, nativeCommandPlan, persistThenDispatch } from "../lib/native-command.mjs";

test("turns /issue into an immediate native no-reply user message", () => {
  const plan = nativeCommandPlan({
    method: "POST",
    pathname: "/session/ses_parent_12345678/command",
    search: "?directory=%2Fhome%2Fopencode%2Fworkspace",
    body: {
      command: "issue",
      arguments: "поменяй фон на чёрный",
      messageID: "msg_user_12345678",
      agent: "chat",
      model: { providerID: "void", modelID: "gpt-5.5" },
    },
  });

  assert.equal(plan.command, "issue");
  assert.equal(plan.sessionID, "ses_parent_12345678");
  assert.equal(plan.upstreamPath, "/session/ses_parent_12345678/message?directory=%2Fhome%2Fopencode%2Fworkspace");
  assert.deepEqual(plan.promptBody, {
    messageID: "msg_user_12345678",
    agent: "chat",
    model: { providerID: "void", modelID: "gpt-5.5" },
    noReply: true,
    parts: [{ type: "text", text: "/issue поменяй фон на чёрный" }],
  });
});

test("returns the persisted user message without waiting for GitHub", async () => {
  let releaseDispatch;
  const dispatchBlocked = new Promise((resolve) => { releaseDispatch = resolve; });
  let outcome;
  const persisted = { status: 200, body: Buffer.from('{"info":{"id":"msg_user_12345678"}}') };

  const result = await Promise.race([
    persistThenDispatch({
      plan: nativeCommandPlan({
        method: "POST",
        pathname: "/session/ses_parent_12345678/command",
        search: "",
        body: { command: "issue", arguments: "fix", messageID: "msg_user_12345678" },
      }),
      persist: async () => persisted,
      dispatch: async () => { await dispatchBlocked; return { accepted: true, issueNumber: 57 }; },
      onOutcome: (value) => { outcome = value; },
    }),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 20)),
  ]);

  assert.equal(result, persisted);
  assert.equal(outcome, undefined);
  releaseDispatch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome.issueNumber, 57);
  assert.equal(outcome.messageID, "msg_user_12345678");
});

test("classifies accepted, busy, failed, and empty retry responses", () => {
  assert.deepEqual(harnessCommandOutcome("issue", {
    status: 201,
    body: Buffer.from('{"number":57,"url":"https://example.test/57"}'),
  }), { status: "accepted", issueNumber: 57 });
  assert.deepEqual(harnessCommandOutcome("issue", {
    status: 409,
    body: Buffer.from('{"error":"issue-processing-busy","issueNumber":9}'),
  }), { status: "busy", issueNumber: 9 });
  assert.deepEqual(harnessCommandOutcome("retry", { status: 204, body: Buffer.alloc(0) }), {
    status: "nothing-to-retry",
  });
  assert.deepEqual(harnessCommandOutcome("issue", {
    status: 503,
    body: Buffer.from('{"error":"issue-queue-check-failed"}'),
  }), { status: "failed" });
});
