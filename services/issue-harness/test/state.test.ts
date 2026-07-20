import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  nextRunAction,
  recoverStalePublication,
  StateStore,
  type IssueRunState,
} from "../src/state.js";

function state(
  status: IssueRunState["status"],
  prUrl?: string,
  publicationArtifact: IssueRunState["publicationArtifact"] | null = {
    manifestPath: "/data/artifacts/issue-42/manifest.json",
    manifestSha256: "a".repeat(64),
  },
): IssueRunState {
  return {
    issueNumber: 42,
    branch: "codex/issue-42-retry",
    status,
    prUrl,
    publicationArtifact: publicationArtifact ?? undefined,
    updatedAt: new Date(0).toISOString(),
  };
}

test("retries publication without rerunning the coding agent", () => {
  assert.equal(nextRunAction(state("publish_pending")), "publish");
});

test("reruns legacy publish-pending state that has no immutable artifact", () => {
  assert.equal(nextRunAction(state("publish_pending", undefined, null)), "run");
});

test("repairs labels for a persisted finished run", () => {
  assert.equal(nextRunAction(state("finished", "https://github.com/acme/service/pull/1")), "finalize");
  assert.equal(nextRunAction(state("finished")), "publish");
});

test("runs the agent for new and human-resumed work", () => {
  assert.equal(nextRunAction(), "run");
  assert.equal(nextRunAction(state("awaiting_human")), "run");
});

test("retains a stale artifact for audit but clears the active reference for a fresh rerun", () => {
  const pending = state("publish_pending");
  const recovered = recoverStalePublication(pending, new Date(0).toISOString());

  assert.equal(recovered.status, "awaiting_human");
  assert.match(recovered.branch, /^codex\/issue-42-retry-fresh-/);
  assert.notEqual(recovered.branch, pending.branch);
  assert.equal(recovered.publicationArtifact, undefined);
  assert.deepEqual(recovered.stalePublicationArtifacts, [{
    artifact: pending.publicationArtifact,
    detectedAt: new Date(0).toISOString(),
    reason: "base_changed",
  }]);
  assert.equal(nextRunAction({ ...recovered, updatedAt: new Date(0).toISOString() }), "run");
});

test("loads legacy array state and migrates the next write to schema v2", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateDirectory = path.join(dataDir, "state");
  await fs.mkdir(stateDirectory);
  await fs.writeFile(path.join(stateDirectory, "runs.json"), `${JSON.stringify([state("failed")])}\n`);
  const store = new StateStore(dataDir);

  await store.load();
  assert.equal((await fs.stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal(store.get(42)?.status, "failed");
  await store.set({ issueNumber: 43, branch: "codex/issue-43-new", status: "running" });

  const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "runs.json"), "utf8"));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.runs.length, 2);
  assert.equal((await fs.stat(path.join(stateDirectory, "runs.json"))).mode & 0o777, 0o600);
});

test("serializes concurrent state writes into one valid snapshot", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-state-race-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.load();

  await Promise.all(Array.from({ length: 20 }, (_, index) => store.set({
    issueNumber: index + 1,
    branch: `codex/issue-${index + 1}-test`,
    status: "running",
  })));

  const persisted = JSON.parse(
    await fs.readFile(path.join(dataDir, "state", "runs.json"), "utf8"),
  );
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.runs.length, 20);
  await assert.rejects(fs.access(path.join(dataDir, "state", "runs.json.tmp")));
});
