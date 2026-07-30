import assert from "node:assert/strict";
import test from "node:test";

test("builds a bounded Issue with its OpenCode parent-session marker", async () => {
  const { buildIssueRequest } = await import("../src/issue-command.js");
  const request = buildIssueRequest({
    text: "Repair login validation\n\nThe form accepts an empty email.",
    parentSessionId: "ses_parent_12345678",
  });

  assert.deepEqual(request, {
    title: "Repair login validation",
    body: "Repair login validation\n\nThe form accepts an empty email.\n\n<!-- opencode-harness-parent: ses_parent_12345678 -->",
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
});
