import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./env.js";
import { extractHumanQuestion } from "./completion.js";
import { branchName, pushBranch } from "./git.js";
import { GithubTracker } from "./github.js";
import { startHealthServer } from "./health.js";
import { runAgent } from "./runner.js";
import {
  githubGitAuthEnv,
  githubRepositoryRemote,
  prepareRepositoryWorkspace,
} from "./repository.js";
import { nextRunAction, StateStore } from "./state.js";
import { redactForGithub } from "./security.js";

const tracker = new GithubTracker();
const state = new StateStore(config.dataDir);
const gitEnv = githubGitAuthEnv(config.githubToken);
const remoteUrl = githubRepositoryRemote(config.owner, config.repo);
const outboundSecrets = [config.githubToken, process.env.OPENAI_API_KEY];
let activeRuns = 0;
let lastSuccessfulPollAt = Date.now();

async function tick() {
  if (activeRuns >= config.maxConcurrentRuns) {
    lastSuccessfulPollAt = Date.now();
    return;
  }

  const issue = await tracker.nextIssue();
  lastSuccessfulPollAt = Date.now();
  if (!issue) return;

  activeRuns += 1;
  try {
    await processIssue(issue);
  } finally {
    activeRuns -= 1;
  }
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

  await fs.mkdir(config.dataDir, { recursive: true });
  let workspace;
  try {
    workspace = await prepareRepositoryWorkspace({
      dataDir: config.dataDir,
      owner: config.owner,
      repo: config.repo,
      baseBranch: config.baseBranch,
      remoteUrl,
      gitEnv,
    });
  } catch (error) {
    const message = redactForGithub(error instanceof Error ? error.message : String(error), outboundSecrets);
    await state.set({
      issueNumber: issue.number,
      branch,
      status: retryingPublish ? "publish_pending" : "failed",
      lastSessionId: existing?.lastSessionId,
      lastLogPath: existing?.lastLogPath,
    });
    await tracker.needsHuman(
      issue.number,
      `Codex run failed before finishing.\n\n\`\`\`text\n${message}\n\`\`\`\n\nFix the runner/sandbox problem, remove \`ai:needs-human\`, and the harness will retry.`,
    );
    return;
  }

  if (retryingPublish) {
    await publishIssue(issue, branch, workspace);
    return;
  }

  const comments = await tracker.recentComments(issue.number);
  await state.set({ issueNumber: issue.number, branch, status: "running" });

  let result;
  try {
    result = await runAgent(issue, branch, comments, workspace);
  } catch (error) {
    const message = redactForGithub(error instanceof Error ? error.message : String(error), outboundSecrets);
    await state.set({ issueNumber: issue.number, branch, status: "failed" });
    await tracker.needsHuman(
      issue.number,
      `Codex run failed before finishing.\n\n\`\`\`text\n${message}\n\`\`\`\n\nFix the runner/sandbox problem, remove \`ai:needs-human\`, and the harness will retry.`,
    );
    return;
  }
  const question = extractHumanQuestion(result.stdout);

  if (question) {
    await state.set({
      issueNumber: issue.number,
      branch,
      status: "awaiting_human",
      lastSessionId: result.sessionId,
      lastLogPath: result.logFilePath,
    });
    await tracker.needsHuman(issue.number, redactForGithub(question, outboundSecrets));
    return;
  }

  await state.set({
    issueNumber: issue.number,
    branch,
    status: "publish_pending",
    lastSessionId: result.sessionId,
    lastLogPath: result.logFilePath,
  });
  await publishIssue(issue, branch, workspace);
}

async function publishIssue(
  issue: NonNullable<Awaited<ReturnType<GithubTracker["nextIssue"]>>>,
  branch: string,
  workspace: string,
) {
  const pending = state.get(issue.number);
  let prUrl;
  try {
    await pushBranch(branch, workspace, gitEnv);
    prUrl = await tracker.findOrCreatePullRequest(
      issue.number,
      branch,
      issue.title,
      `Automated Codex/Sandcastle run for #${issue.number}.\n\nLog: ${pending?.lastLogPath ?? "not available"}`,
    );
  } catch (error) {
    const message = redactForGithub(error instanceof Error ? error.message : String(error), outboundSecrets);
    await state.set({
      issueNumber: issue.number,
      branch,
      status: "publish_pending",
      lastSessionId: pending?.lastSessionId,
      lastLogPath: pending?.lastLogPath,
    });
    await tracker.needsHuman(
      issue.number,
      `Codex finished locally, but publishing the branch or pull request failed.\n\n\`\`\`text\n${message}\n\`\`\`\n\nFix the GitHub access problem, remove \`ai:needs-human\`, and the harness will retry publication without rerunning the coding agent.`,
    );
    return;
  }

  await state.set({
    issueNumber: issue.number,
    branch,
    status: "finished",
    lastSessionId: pending?.lastSessionId,
    lastLogPath: pending?.lastLogPath,
    prUrl,
  });
  await tracker.moveStatus(issue.number, "finished");
  await tracker.comment(issue.number, `Finished. Pull request: ${prUrl}`);
}

async function main() {
  await state.load();
  await tracker.assertRepositoryAccess();
  await tracker.ensureLabels();
  const workspace = await prepareRepositoryWorkspace({
    dataDir: config.dataDir,
    owner: config.owner,
    repo: config.repo,
    baseBranch: config.baseBranch,
    remoteUrl,
    gitEnv,
  });
  await fs.access(path.join(workspace, ".sandcastle", "prompt.md"));
  await startHealthServer({
    port: config.healthPort,
    repository: `${config.owner}/${config.repo}`,
    workspaceOrigin: remoteUrl,
    isReady: () =>
      Date.now() - lastSuccessfulPollAt < Math.max(config.pollIntervalMs * 3, 180_000),
  });
  console.log(`Issue harness started for ${config.owner}/${config.repo}`);

  await tick();
  setInterval(() => {
    tick().catch((error) => {
      console.error(error);
    });
  }, config.pollIntervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
