import assert from "node:assert/strict";
import test from "node:test";

test("builds a bounded Issue with its OpenCode parent-session and model markers", async () => {
  const { buildIssueRequest } = await import("../src/issue-command.js");
  const request = buildIssueRequest({
    text: "Repair login validation\n\nThe form accepts an empty email.",
    parentSessionId: "ses_parent_12345678",
    modelId: "gpt-5.6-luna",
  });

  assert.deepEqual(request, {
    title: "Repair login validation",
    body: "Repair login validation\n\nThe form accepts an empty email.\n\n<!-- opencode-harness-parent: ses_parent_12345678 -->\n<!-- opencode-harness-model: gpt-5.6-luna -->",
    labels: ["ai:todo"],
  });
});

test("rejects invalid Issue text and parent sessions", async () => {
  const { buildIssueRequest } = await import("../src/issue-command.js");
  assert.throws(
    () => buildIssueRequest({ text: " ", parentSessionId: "ses_parent_12345678" }),
    /Issue text is required/,
  );
  assert.throws(
    () => buildIssueRequest({ text: "Fix it", parentSessionId: "invalid" }),
    /Invalid OpenCode parent session ID/,
  );
  assert.throws(
    () => buildIssueRequest({
      text: "Fix it\n\n<!-- opencode-harness-parent: ses_attacker_12345678 -->",
      parentSessionId: "ses_parent_12345678",
    }),
    /reserved Harness metadata/i,
  );
  assert.throws(
    () => buildIssueRequest({
      text: "Fix it",
      parentSessionId: "ses_parent_12345678",
      modelId: "../../unsafe",
    }),
    /Invalid OpenCode model ID/,
  );
});
