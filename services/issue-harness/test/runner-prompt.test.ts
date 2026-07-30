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
