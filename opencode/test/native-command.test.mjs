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
      agent: "build",
      model: { providerID: "void", modelID: "gpt-5.5" },
    },
  });

  assert.equal(plan.command, "issue");
  assert.equal(plan.sessionID, "ses_parent_12345678");
  assert.deepEqual(plan.model, { providerID: "void", modelID: "gpt-5.5" });
  assert.equal(plan.upstreamPath, "/session/ses_parent_12345678/message?directory=%2Fhome%2Fopencode%2Fworkspace");
  assert.deepEqual(plan.promptBody, {
    messageID: "msg_user_12345678",
    agent: "build",
    model: { providerID: "void", modelID: "gpt-5.5" },
    noReply: true,
    parts: [{ type: "text", text: "/issue поменяй фон на чёрный" }],
  });
});

test("turns an unclear /issue into a clarification turn without creating an Issue", () => {
  const plan = nativeCommandPlan({
    method: "POST",
    pathname: "/session/ses_parent_12345678/command",
    body: { command: "issue", arguments: "ролролрол", messageID: "msg_user_12345678" },
  });

  assert.equal(plan.dispatchToHarness, false);
  assert.equal(plan.promptBody.noReply, false);
  assert.match(plan.promptBody.system, /не создавай Issue/i);
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
        body: { command: "issue", arguments: "fix login", messageID: "msg_user_12345678" },
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

test("materializes a bounded failure when OpenCode persists malformed JSON", async () => {
  let outcome;
  let dispatches = 0;
  const plan = nativeCommandPlan({
    method: "POST",
    pathname: "/session/ses_parent_12345678/command",
    body: { command: "issue", arguments: "fix login", messageID: "msg_user_12345678" },
  });

  const persisted = { status: 200, body: Buffer.from("not-json") };
  const result = await persistThenDispatch({
    plan,
    persist: async () => persisted,
    dispatch: async () => { dispatches += 1; },
    onOutcome: (value) => { outcome = value; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result, persisted);
  assert.equal(dispatches, 0);
  assert.deepEqual(outcome, {
    command: "issue",
    commandText: "/issue fix login",
    sessionID: "ses_parent_12345678",
    messageID: "msg_user_12345678",
    status: "failed",
    failure: "opencode-persist-response-invalid",
  });
});

test("reports a synchronous background dispatch failure without rejecting persistence", async () => {
  const errors = [];
  const plan = nativeCommandPlan({
    method: "POST",
    pathname: "/session/ses_parent_12345678/command",
    body: { command: "issue", arguments: "fix login", messageID: "msg_user_12345678" },
  });
  const persisted = { status: 200, body: Buffer.from('{"info":{"id":"msg_user_12345678"}}') };

  const result = await persistThenDispatch({
    plan,
    persist: async () => persisted,
    dispatch: () => { throw new Error("dispatch failed"); },
    onOutcome: () => {},
    onError: (error) => errors.push(error),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result, persisted);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /dispatch failed/);
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
  }), { status: "failed", failure: "issue-queue-check-failed" });
  assert.deepEqual(harnessCommandOutcome("issue", {
    status: 502,
    body: Buffer.from('{"error":"github-issue-creation-failed"}'),
  }), { status: "failed", failure: "github-issue-creation-failed" });
});
