import assert from "node:assert/strict";
import test from "node:test";
import { forwardHumanAnswer } from "../lib/answer.mjs";

test("forwards an ordinary parent message when Harness is awaiting an answer", async () => {
  let body;
  const result = await forwardHumanAnswer({
    text: "Use PostgreSQL",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://issue-harness:3000/commands/answers",
    commandToken: "command-secret",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ issueNumber: 57 }, { status: 202 });
    },
  });

  assert.deepEqual(body, { text: "Use PostgreSQL", parentSessionId: "ses_parent_12345678" });
  assert.deepEqual(result, { accepted: true, issueNumber: 57 });
});

test("leaves normal chat untouched when no Issue is awaiting an answer", async () => {
  const result = await forwardHumanAnswer({
    text: "How does login work?",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://issue-harness:3000/commands/answers",
    commandToken: "command-secret",
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.deepEqual(result, { accepted: false });
});

test("fails open when Harness is unavailable so normal chat never hangs", async () => {
  const result = await forwardHumanAnswer({
    text: "What color is the page?",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://issue-harness:3000/commands/answers",
    commandToken: "command-secret",
    timeoutMs: 1,
    fetchImpl: async () => new Promise(() => {}),
  });
  assert.deepEqual(result, { accepted: false });
});

test("ignores Harness progress updates and slash commands", async () => {
  let calls = 0;
  const common = {
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://issue-harness:3000/commands/answers",
    commandToken: "command-secret",
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
  };
  assert.deepEqual(await forwardHumanAnswer({ ...common, text: "<!-- opencode-harness-update -->\nStatus" }), { accepted: false });
  assert.deepEqual(await forwardHumanAnswer({ ...common, text: "/issue another task" }), { accepted: false });
  assert.equal(calls, 0);
});

test("uses the loopback Harness proxy without exposing the command token to OpenCode", async () => {
  let authorization = "not-called";
  const result = await forwardHumanAnswer({
    text: "Use PostgreSQL",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://127.0.0.1:4098/commands/answers",
    commandToken: "",
    fetchImpl: async (_url, init) => {
      authorization = init.headers.Authorization;
      return Response.json({ issueNumber: 57 }, { status: 202 });
    },
  });

  assert.equal(authorization, undefined);
  assert.deepEqual(result, { accepted: true, issueNumber: 57 });
});

test("fails open when Harness sends headers but never finishes its response body", async () => {
  const result = await forwardHumanAnswer({
    text: "Use PostgreSQL",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://127.0.0.1:4098/commands/answers",
    commandToken: "",
    timeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(result, { accepted: false });
});
