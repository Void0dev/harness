import { Octokit } from "@octokit/rest";
import { config } from "./env.js";
import { labelColors, labels, statusLabels } from "./labels.js";
import { parseParentSessionId } from "./opencode.js";
import type { TrustedHumanComment } from "./human-comments.js";

const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type TrackerIssue = Awaited<ReturnType<GithubTracker["nextIssue"]>>;

export type PullRequestSummary = {
  number: number;
  url: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
};

type SummarizablePullRequest = {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
};

export class GithubTracker {
  private readonly octokit: Octokit;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  async assertRepositoryAccess() {
    try {
      await this.octokit.rest.repos.get({
        owner: config.owner,
        repo: config.repo,
      });
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        throw new Error(
          [
            `GitHub repository ${config.owner}/${config.repo} was not found or the GitHub App installation cannot access it.`,
            "Check GITHUB_OWNER/GITHUB_REPO, the Installation ID, and that the App is installed on this repository.",
            "Grant Metadata read, Contents read/write, Issues read/write, and Pull requests read/write.",
          ].join(" "),
        );
      }
      throw error;
    }

    for (const branch of ["main", config.baseBranch]) {
      try {
        await this.octokit.rest.repos.getBranch({
          owner: config.owner,
          repo: config.repo,
          branch,
        });
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          throw new Error(`Required GitHub branch ${branch} was not found in ${config.owner}/${config.repo}`);
        }
        throw error;
      }
    }
  }

  async createIssue(request: { title: string; body: string; labels: string[] }) {
    const response = await this.octokit.rest.issues.create({
      owner: config.owner,
      repo: config.repo,
      ...request,
    });
    return { number: response.data.number, url: response.data.html_url };
  }

  async ensureLabels() {
    for (const [name, color] of Object.entries(labelColors)) {
      try {
        await this.octokit.rest.issues.getLabel({
          owner: config.owner,
          repo: config.repo,
          name,
        });
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        await this.octokit.rest.issues.createLabel({
          owner: config.owner,
          repo: config.repo,
          name,
          color,
        });
      }
    }
  }

  async nextIssue() {
    const todo = await this.listIssues(labels.todo);
    const running = await this.listIssues(labels.running);
    const candidates = [...running, ...todo].filter((issue) => {
      const issueLabels = issue.labels.map((label) => (typeof label === "string" ? label : label.name));
      return (
        !issue.pull_request
        && !issueLabels.includes(labels.needsHuman)
        && !issueLabels.includes(labels.finished)
      );
    });
    return candidates[0] ?? null;
  }

  async findBlockingIssue(parentSessionId: string) {
    const groups = await Promise.all([
      this.listIssues(labels.running),
      this.listIssues(labels.todo),
      this.listIssues(labels.needsHuman),
    ]);
    const seen = new Set<number>();
    for (const issue of groups.flat()) {
      if (seen.has(issue.number)) continue;
      seen.add(issue.number);
      if (!issue.pull_request && parseParentSessionId(issue.body) === parentSessionId) return issue;
    }
    return null;
  }

  async recentComments(issueNumber: number) {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      per_page: 20,
    });
    return comments
      .filter((comment) => {
        const body = comment.body ?? "";
        return (
          trustedAssociations.has(comment.author_association) &&
          !body.startsWith("OpenCode picked this up on branch") &&
          !body.startsWith("Human attention needed:\n\nOpenCode run failed before finishing.")
        );
      })
      .slice(-10)
      .map((comment) => `@${comment.user?.login ?? "unknown"}: ${comment.body ?? ""}`)
      .join("\n\n---\n\n");
  }

  async humanReplies(issueNumber: number, afterCommentId: number): Promise<TrustedHumanComment[]> {
    if (!Number.isSafeInteger(afterCommentId) || afterCommentId <= 0) {
      throw new Error("Invalid Harness question comment ID");
    }
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    return comments.flatMap((comment) => {
      const body = comment.body?.trim() ?? "";
      const id = comment.id;
      const author = comment.user?.login ?? "";
      const createdAt = comment.created_at;
      if (
        !Number.isSafeInteger(id)
        || id <= afterCommentId
        || !trustedAssociations.has(comment.author_association)
        || comment.user?.type === "Bot"
        || !author
        || !body
        || Number.isNaN(Date.parse(createdAt))
      ) return [];
      return [{ id, author, body, createdAt }];
    }).sort((left, right) => left.id - right.id);
  }

  async moveStatus(issueNumber: number, status: keyof Pick<typeof labels, "todo" | "running" | "finished">) {
    await this.setStatusLabel(issueNumber, labels[status]);
  }

  async needsHuman(issueNumber: number, body: string) {
    await this.markNeedsHuman(issueNumber);
    return await this.comment(issueNumber, `Human attention needed:\n\n${body}`);
  }

  async markNeedsHuman(issueNumber: number) {
    await this.setStatusLabel(issueNumber, labels.needsHuman);
  }

  private async setStatusLabel(issueNumber: number, target: string) {
    await this.octokit.rest.issues.addLabels({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      labels: [target],
    });

    for (const label of statusLabels) {
      if (label === target) continue;
      try {
        await this.octokit.rest.issues.removeLabel({
          owner: config.owner,
          repo: config.repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
  }

  async comment(issueNumber: number, body: string) {
    const response = await this.octokit.rest.issues.createComment({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      body,
    });
    if (
      !Number.isSafeInteger(response.data.id)
      || response.data.id <= 0
      || typeof response.data.created_at !== "string"
      || Number.isNaN(Date.parse(response.data.created_at))
    ) throw new Error("GitHub returned invalid comment metadata");
    return { id: response.data.id, createdAt: new Date(response.data.created_at).toISOString() };
  }

  async findHarnessPullRequest(issueNumber: number, branch: string): Promise<PullRequestSummary | null> {
    const response = await this.octokit.rest.pulls.list({
      owner: config.owner,
      repo: config.repo,
      state: "open",
      base: config.baseBranch,
      head: `${config.owner}:${branch}`,
      per_page: 100,
    });
    const titlePrefix = `Fix #${positiveInteger(issueNumber, "Issue number")}:`;
    const pullRequest = response.data.find((candidate) =>
      candidate.title.startsWith(titlePrefix)
      && candidate.head.ref === branch
      && candidate.base.ref === config.baseBranch
    );
    return pullRequest ? summarizeListedPullRequest(pullRequest) : null;
  }

  private async listIssues(label: string) {
    return await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: config.owner,
      repo: config.repo,
      state: "open",
      labels: label,
      per_page: 20,
      sort: "created",
      direction: "asc",
    });
  }
}

function summarizeListedPullRequest(pullRequest: SummarizablePullRequest): PullRequestSummary {
  const state = pullRequestState(pullRequest.state);
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    state,
    draft: pullRequest.draft === true,
    merged: pullRequest.merged === true || typeof pullRequest.merged_at === "string",
    headBranch: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    baseBranch: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
  };
}

function pullRequestState(state: string) {
  if (state !== "open" && state !== "closed") throw new Error("GitHub returned an invalid pull request state");
  return state;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
