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
    const todo = await this.listIssues(labels.todo, 1);
    const running = await this.listIssues(labels.running, 1);
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
    if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)) {
      throw new Error("Invalid OpenCode parent session ID");
    }
    const response = await this.octokit.rest.search.issuesAndPullRequests({
      q: `repo:${config.owner}/${config.repo} is:issue is:open in:body "opencode-harness-parent: ${parentSessionId}"`,
      per_page: 10,
    });
    return response.data.items.find((issue) => {
      const issueLabels = issue.labels.map((label) => (typeof label === "string" ? label : label.name));
      return !issue.pull_request
        && !issueLabels.includes(labels.finished)
        && parseParentSessionId(issue.body) === parentSessionId;
    }) ?? null;
  }

  async recentComments(issueNumber: number) {
    const comments = await this.latestIssueComments(issueNumber, 3);
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
    const comments = await this.latestIssueComments(issueNumber, 5);
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

  async ensureHumanQuestion(issueNumber: number, body: string) {
    await this.markNeedsHuman(issueNumber);
    const commentBody = `Human attention needed:\n\n${body}`;
    const comments = await this.latestIssueComments(issueNumber, 3);
    const existing = [...comments].reverse().find((comment) =>
      comment.body === commentBody && comment.user?.type === "Bot");
    return existing ? commentMetadata(existing) : await this.comment(issueNumber, commentBody);
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
    return commentMetadata(response.data);
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

  private async listIssues(label: string, maximumPages: number) {
    const issues = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const response = await this.octokit.rest.issues.listForRepo({
        owner: config.owner,
        repo: config.repo,
        state: "open",
        labels: label,
        per_page: 20,
        page,
        sort: "created",
        direction: "asc",
      });
      issues.push(...response.data);
      if (response.data.length < 20) break;
    }
    return issues;
  }

  private async latestIssueComments(issueNumber: number, maximumPages: number) {
    const issue = await this.octokit.rest.issues.get({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
    });
    const count = issue.data.comments;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("GitHub returned an invalid Issue comment count");
    if (count === 0) return [];
    const lastPage = Math.ceil(count / 100);
    const firstPage = Math.max(1, lastPage - maximumPages + 1);
    const pages = Array.from({ length: lastPage - firstPage + 1 }, (_, index) => lastPage - index);
    const responses = await Promise.all(pages.map((page) => this.octokit.rest.issues.listComments({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    })));
    return responses.flatMap((response) => response.data).sort((left, right) => left.id - right.id);
  }
}

function commentMetadata(comment: { id?: unknown; created_at?: unknown }) {
  if (
    !Number.isSafeInteger(comment.id)
    || Number(comment.id) <= 0
    || typeof comment.created_at !== "string"
    || Number.isNaN(Date.parse(comment.created_at))
  ) throw new Error("GitHub returned invalid comment metadata");
  return { id: Number(comment.id), createdAt: new Date(comment.created_at).toISOString() };
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
