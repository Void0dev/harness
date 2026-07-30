import assert from "node:assert/strict";
import test from "node:test";
import { requestTechnicalRetry } from "../lib/retry.mjs";
import { createRetryHooks } from "../lib/retry-plugin.mjs";

test("queues an explicit technical retry through the loopback proxy", async () => {
  let observed;
  const result = await requestTechnicalRetry({
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://127.0.0.1:4098/commands/retries",
    commandToken: "",
    instruction: "Используй красный цвет без градиента",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return Response.json({ issueNumber: 57 }, { status: 202 });
    },
  });

  assert.equal(observed.url, "http://127.0.0.1:4098/commands/retries");
  assert.equal(observed.init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(observed.init.body), {
    parentSessionId: "ses_parent_12345678",
    instruction: "Используй красный цвет без градиента",
  });
  assert.deepEqual(result, { accepted: true, issueNumber: 57 });
});

test("preserves the exact /retry command while reporting the accepted Issue", async () => {
  let observedInstruction;
  const hooks = createRetryHooks({
    requestRetry: async ({ instruction }) => {
      observedInstruction = instruction;
      return { accepted: true, issueNumber: 57 };
    },
    harnessUrl: "http://127.0.0.1:4098/commands/retries",
    commandToken: "",
  });
  const output = { parts: [{ type: "text", text: "original" }] };

  await hooks["command.execute.before"]({
    command: "retry",
    arguments: "Используй красный цвет без градиента",
    sessionID: "ses_parent_12345678",
  }, output);

  assert.equal(observedInstruction, "Используй красный цвет без градиента");
  assert.match(output.parts[0].text, /Issue #57/);
  assert.match(output.parts[0].text, /\/retry Используй красный цвет без градиента$/);
});

test("reports that there is nothing to retry without throwing", async () => {
  const hooks = createRetryHooks({
    requestRetry: async () => ({ accepted: false }),
    harnessUrl: "http://127.0.0.1:4098/commands/retries",
    commandToken: "",
  });
  const output = { parts: [{ type: "text", text: "original" }] };

  await hooks["command.execute.before"]({ command: "retry", arguments: "", sessionID: "ses_parent_12345678" }, output);

  assert.match(output.parts[0].text, /нечего повторять/i);
  assert.match(output.parts[0].text, /\/retry$/);
});

test("shows a bounded retry error instead of an OpenCode server exception", async () => {
  const hooks = createRetryHooks({
    requestRetry: async () => { throw new Error("secret internal details"); },
    harnessUrl: "http://127.0.0.1:4098/commands/retries",
    commandToken: "",
  });
  const output = { parts: [{ type: "text", text: "original" }] };

  await assert.doesNotReject(hooks["command.execute.before"]({ command: "retry", arguments: "", sessionID: "ses_parent_12345678" }, output));
  assert.match(output.parts[0].text, /не удалось повторить/i);
  assert.doesNotMatch(output.parts[0].text, /secret/i);
  assert.match(output.parts[0].text, /\/retry$/);
});
