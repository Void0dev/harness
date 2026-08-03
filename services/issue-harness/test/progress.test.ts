import assert from "node:assert/strict";
import test from "node:test";
import { appendObservedStage, parseChangedFileStats, stageFromMessageParts, summarizeWorkerResult } from "../src/progress.js";

test("derives only stages evidenced by OpenCode tool parts", () => {
  assert.equal(stageFromMessageParts([{ type: "tool", tool: "read", state: { input: { filePath: "src/a.ts" } } }]), "studying");
  assert.equal(stageFromMessageParts([{ type: "tool", tool: "edit", state: { input: { filePath: "src/a.ts" } } }]), "coding");
  assert.equal(stageFromMessageParts([{ type: "tool", tool: "bash", state: { input: { command: "npm test" } } }]), "testing");
  assert.equal(stageFromMessageParts([{ type: "tool", tool: "bash", state: { input: { command: "git status" } } }]), undefined);
});

test("appends stages canonically without inventing skipped checks", () => {
  assert.deepEqual(appendObservedStage(["accepted", "studying"], "coding"), ["accepted", "studying", "coding"]);
  assert.deepEqual(appendObservedStage(["accepted", "coding"], "publishing"), ["accepted", "coding", "publishing"]);
  assert.deepEqual(appendObservedStage(["accepted", "coding"], "studying"), ["accepted", "coding"]);
});

test("turns a worker final response into a bounded clean summary", () => {
  assert.equal(
    summarizeWorkerResult("Implemented login validation.\n\n<promise>COMPLETE</promise>"),
    "Implemented login validation.",
  );
});

test("builds file statistics for safe changed paths", () => {
  assert.deepEqual(parseChangedFileStats(
    "12\t3\tsrc/login.ts\n-\t-\tassets/logo.png\n99\t0\t../secret\n",
  ), [
    { path: "assets/logo.png" },
    { path: "src/login.ts", additions: 12, deletions: 3 },
  ]);
});
