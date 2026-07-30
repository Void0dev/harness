import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupExpiredWorkspaces } from "../src/retention.js";
import type { IssueRunState } from "../src/state.js";

function run(overrides: Partial<IssueRunState>): IssueRunState {
  return {
    issueNumber: 57,
    branch: "opencode/issue-57-test",
    status: "finished",
    prUrl: "https://github.com/acme/service/pull/57",
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("removes only an expired completed workspace and keeps active work", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-retention-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const expired = path.join(dataDir, "runs", "issue-57", "run-expired");
  const active = path.join(dataDir, "runs", "issue-58", "run-active");
  await fs.mkdir(expired, { recursive: true });
  await fs.mkdir(active, { recursive: true });

  await cleanupExpiredWorkspaces({
    dataDir,
    now: new Date("2026-07-30T00:00:00.000Z"),
    retentionMs: 24 * 60 * 60 * 1000,
    states: [
      run({ workspace: expired, updatedAt: new Date("2026-07-28T00:00:00.000Z").toISOString() }),
      run({ issueNumber: 58, status: "running", workspace: active, updatedAt: new Date("2026-07-28T00:00:00.000Z").toISOString() }),
    ],
  });

  await assert.rejects(fs.access(expired));
  await fs.access(active);
  await fs.access(path.join(dataDir, "runs"));
});

test("removes superseded retry workspaces but never follows an outside path", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-retention-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const oldWorkspace = path.join(dataDir, "runs", "issue-57", "run-old");
  const currentWorkspace = path.join(dataDir, "runs", "issue-57", "run-current");
  const outside = path.join(dataDir, "outside");
  await Promise.all([
    fs.mkdir(oldWorkspace, { recursive: true }),
    fs.mkdir(currentWorkspace, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ]);

  await cleanupExpiredWorkspaces({
    dataDir,
    now: new Date("2026-07-30T00:00:00.000Z"),
    retentionMs: 24 * 60 * 60 * 1000,
    states: [
      run({ status: "running", workspace: currentWorkspace }),
      run({ issueNumber: 58, workspace: outside }),
    ],
  });

  await assert.rejects(fs.access(oldWorkspace));
  await fs.access(currentWorkspace);
  await fs.access(outside);
});
