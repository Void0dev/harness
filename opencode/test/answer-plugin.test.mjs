import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerHooks } from "../lib/answer-plugin.mjs";

test("starts the bounded Harness context refresh without delaying user-message persistence", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const hooks = createAnswerHooks({
    forward: async () => {
      await barrier;
    },
    harnessUrl: "http://issue-harness:3000/commands/answers",
    commandToken: "command-secret",
  });

  const result = await Promise.race([
    hooks["chat.message"](
    { sessionID: "ses_parent_12345678" },
    { parts: [{ type: "text", text: "Continue our discussion" }] },
    ).then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 20)),
  ]);
  assert.equal(result, "completed");
  release();
});

test("reports background forwarding failures without rejecting the chat hook", async () => {
  const errors = [];
  const hooks = createAnswerHooks({
    forward: async () => { throw new Error("Harness unavailable"); },
    harnessUrl: "http://issue-harness:3000/commands/answers",
    commandToken: "command-secret",
    onError: (error) => errors.push(error),
  });

  await hooks["chat.message"](
    { sessionID: "ses_parent_12345678" },
    { parts: [{ type: "text", text: "Continue our discussion" }] },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /Harness unavailable/);
});
