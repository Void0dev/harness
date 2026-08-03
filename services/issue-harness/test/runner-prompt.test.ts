import assert from "node:assert/strict";
import test from "node:test";
import { buildIssuePrompt } from "../src/worker-prompt.js";

test("requires Russian user-facing summaries and questions from the coding worker", () => {
  const prompt = buildIssuePrompt({
    number: 57,
    title: "Change the background",
    body: "Use red",
    html_url: "https://github.com/acme/service/issues/57",
  }, "opencode/issue-57-change-background", "No comments");

  assert.match(prompt, /final summary.*Russian/i);
  assert.match(prompt, /human question.*Russian/i);
});

test("requires the coding worker to publish a draft pull request itself", () => {
  const prompt = buildIssuePrompt({
    number: 57,
    title: "Change the background",
    body: "Use red",
    html_url: "https://github.com/acme/service/issues/57",
  }, "opencode/issue-57-change-background", "No comments");

  assert.match(prompt, /harness-github git push.*origin.*opencode\/issue-57-change-background/i);
  assert.match(prompt, /harness-github gh pr create/i);
  assert.match(prompt, /--base stage/i);
  assert.match(prompt, /--draft/i);
  assert.match(prompt, /Fix #57:/);
  assert.match(prompt, /finish only after.*pull request exists/i);
});
