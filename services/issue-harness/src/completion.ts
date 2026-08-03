import type { PullRequestSummary } from "./github.js";

export const COMPLETION_MARKER = "<promise>COMPLETE</promise>";

export function hasHumanAttention(stdout: string) {
  return /<human-attention>[\s\S]*?<\/human-attention>/i.test(stdout);
}

export function humanAttentionQuestion(stdout: string) {
  const match = /<human-attention>([\s\S]*?)<\/human-attention>/i.exec(stdout);
  const question = match?.[1]?.trim();
  return question ? question.slice(0, 4_000) : undefined;
}

export function assertAgentRunComplete(options: {
  stdout: string;
  completionSignal?: string;
  hasBranchCommits: boolean;
  worktreeClean: boolean;
}) {
  if (hasHumanAttention(options.stdout)) return;
  if (options.completionSignal !== COMPLETION_MARKER) {
    throw new Error("OpenCode stopped without the required completion signal");
  }
  if (!options.hasBranchCommits) {
    throw new Error("OpenCode completed with an empty branch and no commit ahead of the base branch");
  }
  if (!options.worktreeClean) {
    throw new Error("OpenCode completed with uncommitted work in the execution checkout");
  }
}

export function assertDraftPullRequestMatchesRun(options: {
  pullRequest: PullRequestSummary;
  branch: string;
  headSha: string;
  baseBranch: string;
}) {
  const pullRequest = options.pullRequest;
  if (!pullRequest.draft || pullRequest.state !== "open" || pullRequest.merged) {
    throw new Error("The coding agent pull request is not an open draft");
  }
  if (pullRequest.headBranch !== options.branch || pullRequest.baseBranch !== options.baseBranch) {
    throw new Error("The coding agent pull request has an unexpected branch topology");
  }
  if (pullRequest.headSha !== options.headSha) {
    throw new Error("The coding agent pull request head SHA does not match the completed branch");
  }
}
