import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./env.js";
import { hasHumanAttention } from "./completion.js";
import { branchName } from "./git.js";
import { GithubTracker } from "./github.js";
import { startHealthServer } from "./health.js";
import { runAgent } from "./runner.js";
import {
  githubGitAuthEnv,
  githubRepositoryRemote,
  prepareIsolatedExecutionWorkspace,
} from "./repository.js";
import { nextRunAction, recoverStalePublication, StateStore } from "./state.js";
import {
  acquireProcessLock,
  ensurePrivateRuntimeDirectory,
  ensureRuntimeIdentity,
  publicHarnessStatus,
} from "./security.js";
import { publishArtifact, StalePublicationArtifactError } from "./publisher.js";
import { RunScheduler } from "./scheduler.js";

const tracker = new GithubTracker();
const state = new StateStore(config.dataDir);
const gitEnv = githubGitAuthEnv(config.githubToken);
const remoteUrl = githubRepositoryRemote(config.owner, config.repo);
const outboundSecrets = [
  config.githubToken,
  config.codexBrokerSigningSecret,
  config.healthDetailsToken,
];
const scheduler = new RunScheduler<NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>>(
  config.maxConcurrentRuns,
  (issue) => issue.number,
);
let lastSuccessfulPollAt: number | null = null;
let lastWorkerHeartbeatAt: number | null = null;
let pollState: "waiting" | "polling" = "waiting";
let runState: "idle" | "running" = "idle";

async function tick() {
  await scheduler.poll(
    async () => {
      pollState = "polling";
      try {
        const issue = await tracker.nextIssue();
        lastSuccessfulPollAt = Date.now();
        return issue;
      } finally {
        pollState = "waiting";
      }
    },
    async (issue) => {
      runState = "running";
      try {
        await processIssue(issue);
      } finally {
        runState = "idle";
      }
    },
  );
}

async function processIssue(issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>) {
  const existing = state.get(issue.number);
  const branch = existing?.branch ?? branchName(issue.number, issue.title);
  const action = nextRunAction(existing);
  if (action === "finalize") {
    await tracker.moveStatus(issue.number, "finished");
    return;
  }
  const retryingPublish = action === "publish";

  await tracker.moveStatus(issue.number, "running");
  if (!existing) {
    await tracker.comment(issue.number, `Codex picked this up on branch \`${branch}\`.`);
  }

  if (retryingPublish) {
    await publishIssue(issue, branch);
    return;
  }

  await ensurePrivateRuntimeDirectory(config.dataDir);
  let execution;
  try {
    execution = await prepareIsolatedExecutionWorkspace({
      dataDir: config.dataDir,
      issueNumber: issue.number,
      remoteUrl,
      baseBranch: config.baseBranch,
      gitEnv,
    });
  } catch (error) {
    console.error("Workspace preparation failed", error);
    await state.set({
      issueNumber: issue.number,
      branch,
      status: "failed",
      lastSessionId: existing?.lastSessionId,
      lastLogPath: existing?.lastLogPath,
    });
    await tracker.needsHuman(
      issue.number,
      publicHarnessStatus("run-failed"),
    );
    return;
  }

  const comments = await tracker.recentComments(issue.number);
  await state.set({ issueNumber: issue.number, branch, status: "running" });

  let result;
  try {
    result = await runAgent(issue, branch, comments, execution.workspace, execution.baseSha);
  } catch (error) {
    console.error("Coding run failed", error);
    await state.set({ issueNumber: issue.number, branch, status: "failed" });
    await tracker.needsHuman(
      issue.number,
      publicHarnessStatus("run-failed"),
    );
    return;
  } finally {
    await fs.rm(execution.workspace, { recursive: true, force: true });
  }
  const needsHuman = hasHumanAttention(result.stdout);

  if (needsHuman) {
    await state.set({
      issueNumber: issue.number,
      branch,
      status: "awaiting_human",
      lastSessionId: result.sessionId,
      lastLogPath: result.logFilePath,
    });
    await tracker.needsHuman(issue.number, publicHarnessStatus("human-attention"));
    return;
  }

  if (!result.publicationArtifact) {
    throw new Error("Completed agent run did not produce a publication artifact");
  }

  await state.set({
    issueNumber: issue.number,
    branch,
    status: "publish_pending",
    lastSessionId: result.sessionId,
    lastLogPath: result.logFilePath,
    publicationArtifact: result.publicationArtifact,
  });
  await publishIssue(issue, branch);
}

async function publishIssue(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  branch: string,
) {
  const pending = state.get(issue.number);
  if (!pending?.publicationArtifact) {
    throw new Error("Refusing to publish without an immutable publication artifact");
  }
  let prUrl;
  let publishedCommitSha;
  try {
    const published = await publishArtifact({
      dataDir: config.dataDir,
      remoteUrl,
      baseBranch: config.baseBranch,
      issueNumber: issue.number,
      branch,
      artifact: pending.publicationArtifact,
      gitEnv,
      configuredSecrets: outboundSecrets,
    });
    publishedCommitSha = published.commitSha;
    prUrl = await tracker.findOrCreatePullRequest(
      issue.number,
      branch,
      issue.title,
      `Automated Codex/Sandcastle run for #${issue.number}.`,
    );
  } catch (error) {
    console.error("Publication failed", error);
    if (error instanceof StalePublicationArtifactError) {
      await state.set(recoverStalePublication(pending, new Date().toISOString()));
      await tracker.needsHuman(issue.number, publicHarnessStatus("stale-base"));
      return;
    }
    await state.set({
      issueNumber: issue.number,
      branch,
      status: "publish_pending",
      lastSessionId: pending?.lastSessionId,
      lastLogPath: pending?.lastLogPath,
      publicationArtifact: pending.publicationArtifact,
      publishedCommitSha: pending.publishedCommitSha,
    });
    await tracker.needsHuman(
      issue.number,
      publicHarnessStatus("publication-failed"),
    );
    return;
  }

  await state.set({
    issueNumber: issue.number,
    branch,
    status: "finished",
    lastSessionId: pending?.lastSessionId,
    lastLogPath: pending?.lastLogPath,
    publicationArtifact: pending.publicationArtifact,
    publishedCommitSha,
    prUrl,
  });
  await tracker.moveStatus(issue.number, "finished");
  await tracker.comment(issue.number, `Finished. Pull request: ${prUrl}`);
}

async function main() {
  await ensureRuntimeIdentity(config.dataDir, `${config.owner}/${config.repo}`);
  await acquireProcessLock(config.dataDir);
  await state.load();
  await tracker.assertRepositoryAccess();
  await tracker.ensureLabels();
  await startHealthServer({
    port: config.healthPort,
    repository: `${config.owner}/${config.repo}`,
    workspaceOrigin: remoteUrl,
    isReady: () => {
      const staleAfterMs = Math.max(config.pollIntervalMs * 3, 180_000);
      const pollIsFresh = lastSuccessfulPollAt !== null
        && Date.now() - lastSuccessfulPollAt < staleAfterMs;
      const heartbeatIsFresh = lastWorkerHeartbeatAt !== null
        && Date.now() - lastWorkerHeartbeatAt < staleAfterMs;
      return pollIsFresh || (runState === "running" && heartbeatIsFresh);
    },
    getWorkerHeartbeatAt: () => lastWorkerHeartbeatAt,
    getWorkerActivity: () => ({ poll: pollState, run: runState }),
    workerHeartbeatStaleAfterMs: Math.max(config.pollIntervalMs * 3, 180_000),
    healthDetailsToken: config.healthDetailsToken,
  });
  console.log(`Issue harness started for ${config.owner}/${config.repo}`);

  const heartbeatIntervalMs = Math.min(10_000, Math.max(1_000, Math.floor(config.pollIntervalMs / 3)));
  lastWorkerHeartbeatAt = Date.now();
  setInterval(() => {
    lastWorkerHeartbeatAt = Date.now();
  }, heartbeatIntervalMs).unref();

  const poll = () => {
    tick().catch((error) => {
      console.error(error);
    });
  };
  setInterval(poll, config.pollIntervalMs);
  poll();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
