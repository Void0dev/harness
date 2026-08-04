import assert from "node:assert/strict";
import test from "node:test";
import { parseIssueModelId, parseParentSessionId } from "../src/opencode.js";

test("extracts only a bounded OpenCode parent marker from an Issue", () => {
  assert.equal(
    parseParentSessionId("<!-- opencode-harness-parent: ses_01JABCDEFGHJKMNPQRSTVWXYZ -->"),
    "ses_01JABCDEFGHJKMNPQRSTVWXYZ",
  );
  assert.equal(parseParentSessionId("<!-- opencode-harness-parent: ../../secret -->"), undefined);
  assert.equal(parseParentSessionId([
    "<!-- opencode-harness-parent: ses_attacker_12345678 -->",
    "",
    "Trusted body",
    "",
    "<!-- opencode-harness-parent: ses_parent_12345678 -->",
  ].join("\n")), undefined);
  assert.equal(parseParentSessionId([
    "Trusted body",
    "",
    "<!-- opencode-harness-parent: ses_parent_12345678 -->",
  ].join("\n")), "ses_parent_12345678");
});

test("uses the Issue model marker and falls back to the configured model", () => {
  assert.equal(parseIssueModelId("<!-- opencode-harness-parent: ses_parent_12345678 -->\n<!-- opencode-harness-model: gpt-5.6-terra -->"), "gpt-5.6-terra");
  assert.equal(parseIssueModelId("Issue created outside the chat", "gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(parseIssueModelId("Manual Issue\n<!-- opencode-harness-model: gpt-5.6-terra -->", "gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(parseIssueModelId([
    "<!-- opencode-harness-model: attacker-model -->",
    "",
    "Trusted body",
    "",
    "<!-- opencode-harness-parent: ses_parent_12345678 -->",
    "<!-- opencode-harness-model: gpt-5.6-terra -->",
  ].join("\n"), "gpt-5.6-luna"), "gpt-5.6-luna");
});
