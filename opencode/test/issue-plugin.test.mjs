import assert from "node:assert/strict";
import test from "node:test";
import { createIssueHooks } from "../lib/issue-plugin.mjs";

function invocation() {
  return {
    input: { command: "issue", arguments: "Change blue to red", sessionID: "ses_parent_12345678" },
    output: { parts: [{ type: "text", text: "original" }] },
  };
}

test("preserves the exact /issue command after successful Issue creation", async () => {
  const hooks = createIssueHooks({
    createIssue: async () => ({ number: 57, url: "https://github.com/acme/service/issues/57" }),
    harnessUrl: "http://127.0.0.1:4098/commands/issues",
    commandToken: "",
  });
  const { input, output } = invocation();

  await hooks["command.execute.before"](input, output);

  assert.equal(output.parts[0].text, "/issue Change blue to red\n\n<!-- opencode-harness-issue: 57 -->");
});

test("preserves the /issue command inside a bounded internal-failure envelope", async () => {
  const hooks = createIssueHooks({
    createIssue: async () => { throw new Error("connection refused"); },
    harnessUrl: "http://127.0.0.1:4098/commands/issues",
    commandToken: "",
  });
  const { input, output } = invocation();

  await assert.doesNotReject(hooks["command.execute.before"](input, output));
  assert.match(output.parts[0].text, /не удалось создать Issue/i);
  assert.doesNotMatch(output.parts[0].text, /connection refused/i);
  assert.match(output.parts[0].text, /\/issue Change blue to red$/);
});

test("keeps a busy rejection visible without creating another Issue", async () => {
  const hooks = createIssueHooks({
    createIssue: async () => ({ busy: true, issueNumber: 12 }),
    harnessUrl: "http://127.0.0.1:4098/commands/issues",
    commandToken: "",
  });
  const { input, output } = invocation();

  await hooks["command.execute.before"](input, output);

  assert.match(output.parts[0].text, /Issue #12/);
  assert.match(output.parts[0].text, /дождитесь/i);
  assert.match(output.parts[0].text, /\/issue Change blue to red$/);
});
