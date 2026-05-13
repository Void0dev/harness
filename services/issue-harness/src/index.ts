import fs from "node:fs/promises";
import { config } from "./env.js";
import { branchName, pushBranch } from "./git.js";
import { GithubTracker } from "./github.js";
import { extractHumanQuestion, runAgent } from "./runner.js";
import { StateStore } from "./state.js";

const tracker = new GithubTracker();
const state = new StateStore(config.dataDir);
let activeRuns = 0;

async function tick() {
  if (activeRuns >= config.maxConcurrentRuns) return;

  const issue = await tracker.nextIssue();
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
  const wasAlreadyRunning = existing?.status === "running";

  await tracker.moveStatus(issue.number, "running");
  if (!wasAlreadyRunning) {
    await tracker.comment(issue.number, `Codex picked this up on branch \`${branch}\`.`);
  }

  await fs.mkdir(config.dataDir, { recursive: true });
  const comments = await tracker.recentComments(issue.number);
  await state.set({
    issueNumber: issue.number,
    branch,
    status: "running",
  });

  let result;
  try {
    result = await runAgent(issue, branch, comments);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await state.set({
      issueNumber: issue.number,
      branch,
      status: "failed",
    });
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
    await tracker.needsHuman(issue.number, question);
    return;
  }

  await pushBranch(branch);
  const prUrl = await tracker.createPullRequest(
    issue.number,
    branch,
    issue.title,
    `Automated Codex/Sandcastle run for #${issue.number}.\n\nLog: ${result.logFilePath ?? "not available"}`,
  );

  await state.set({
    issueNumber: issue.number,
    branch,
    status: "finished",
    lastSessionId: result.sessionId,
    lastLogPath: result.logFilePath,
    prUrl,
  });
  await tracker.moveStatus(issue.number, "finished");
  await tracker.comment(issue.number, `Finished. Pull request: ${prUrl}`);
}

async function main() {
  await state.load();
  await tracker.assertRepositoryAccess();
  await tracker.ensureLabels();
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
