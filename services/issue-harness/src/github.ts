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

export type PullRequestBlocker = {
  kind: "draft" | "state" | "mergeability" | "check" | "review" | "unavailable";
  detail: string;
  name?: string;
};

export type PullRequestInspection = {
  pullRequest: PullRequestSummary;
  readiness: "ready" | "blocked" | "unknown" | "already-merged";
  mergeable: boolean | null;
  mergeableState: string;
  mergeCommitSha: string | null;
  checks: Array<{ name: string; status: string; conclusion: string | null; url?: string }>;
  reviews: Array<{ author: string; state: string; submittedAt: string | null }>;
  blockers: PullRequestBlocker[];
};

export type PullRequestMergeResult =
  | {
      kind: "merged" | "already-merged";
      pullRequestNumber: number;
      url: string;
      mergeSha: string;
    }
  | {
      kind: "blocked" | "unknown";
      pullRequestNumber: number;
      url: string;
      reason: string;
      inspection?: PullRequestInspection;
    };

export type PromotionPullRequestResult =
  | { kind: "created" | "reused"; pullRequest: PullRequestSummary; stageSha: string; mainSha: string }
  | { kind: "already-promoted"; stageSha: string; mainSha: string };

type PullRequestData = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];
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

const readyForReviewMutation = `
  mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) {
      pullRequest {
        number
        url
        isDraft
      }
    }
  }
`;

const passingCheckConclusions = new Set(["success", "neutral", "skipped"]);
const mergeableStates = new Set(["clean", "has_hooks"]);

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

  async findOrCreatePullRequest(issueNumber: number, branch: string, title: string, body: string) {
    const existing = await this.findOpenPullRequest(branch);
    if (existing) return existing;
    try {
      const pr = await this.octokit.rest.pulls.create({
        owner: config.owner,
        repo: config.repo,
        base: config.baseBranch,
        head: branch,
        title: `Fix #${issueNumber}: ${title}`,
        body,
        maintainer_can_modify: true,
        draft: true,
      });
      return pr.data.html_url;
    } catch (error) {
      try {
        const createdDespiteError = await this.findOpenPullRequest(branch);
        if (createdDespiteError) return createdDespiteError;
      } catch {
        // Preserve the create error; the persisted publish_pending state will retry later.
      }
      throw error;
    }
  }

  async findHarnessPullRequest(issueNumber: number, branch: string): Promise<PullRequestSummary | null> {
    const response = await this.octokit.rest.pulls.list({
      owner: config.owner,
      repo: config.repo,
      state: "all",
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

  async markStagePullRequestReady(pullNumber: number) {
    const pullRequest = await this.getPullRequest(pullNumber);
    const summary = summarizePullRequest(pullRequest);
    if (summary.baseBranch !== config.baseBranch || summary.headBranch === "main") {
      return {
        kind: "blocked" as const,
        pullRequestNumber: summary.number,
        url: summary.url,
        reason: `Only feature -> ${config.baseBranch} pull requests may be marked ready here`,
      };
    }
    if (summary.merged) {
      return { kind: "already-merged" as const, pullRequestNumber: summary.number, url: summary.url };
    }
    if (summary.state !== "open") {
      return {
        kind: "blocked" as const,
        pullRequestNumber: summary.number,
        url: summary.url,
        reason: "Closed pull requests cannot be marked ready",
      };
    }
    if (!summary.draft) {
      return { kind: "already-ready" as const, pullRequestNumber: summary.number, url: summary.url };
    }

    try {
      const response = await this.octokit.graphql<{
        markPullRequestReadyForReview: {
          pullRequest: { number: number; url: string; isDraft: boolean };
        };
      }>(readyForReviewMutation, { pullRequestId: pullRequest.node_id });
      const ready = response.markPullRequestReadyForReview.pullRequest;
      if (ready.isDraft) throw new Error("GitHub kept the pull request in draft state");
      return { kind: "ready" as const, pullRequestNumber: ready.number, url: ready.url };
    } catch (error) {
      const current = summarizePullRequest(await this.getPullRequest(pullNumber));
      if (current.merged) {
        return { kind: "already-merged" as const, pullRequestNumber: current.number, url: current.url };
      }
      if (!current.draft) {
        return { kind: "already-ready" as const, pullRequestNumber: current.number, url: current.url };
      }
      throw error;
    }
  }

  async inspectPullRequest(pullNumber: number): Promise<PullRequestInspection> {
    return await this.inspectPullRequestData(await this.getPullRequest(pullNumber));
  }

  async mergeStagePullRequest(pullNumber: number): Promise<PullRequestMergeResult> {
    const pullRequest = await this.getPullRequest(pullNumber);
    if (
      pullRequest.base.ref !== config.baseBranch
      || pullRequest.head.ref === config.baseBranch
      || pullRequest.head.ref === "main"
    ) {
      return topologyBlocked(pullRequest, `Only feature -> ${config.baseBranch} pull requests may be merged here`);
    }
    return await this.mergeInspectedPullRequest(pullRequest);
  }

  async readReleaseHeads() {
    const [stage, main] = await Promise.all([
      this.octokit.rest.repos.getBranch({ owner: config.owner, repo: config.repo, branch: config.baseBranch }),
      this.octokit.rest.repos.getBranch({ owner: config.owner, repo: config.repo, branch: "main" }),
    ]);
    return { stageSha: stage.data.commit.sha, mainSha: main.data.commit.sha };
  }

  async findOrCreatePromotionPullRequest(title: string, body: string): Promise<PromotionPullRequestResult> {
    const heads = await this.readReleaseHeads();
    if (heads.stageSha === heads.mainSha) return { kind: "already-promoted", ...heads };

    const existing = await this.findPromotionPullRequest(heads.stageSha);
    if (existing) return { kind: "reused", pullRequest: existing, ...heads };

    try {
      const response = await this.octokit.rest.pulls.create({
        owner: config.owner,
        repo: config.repo,
        base: "main",
        head: config.baseBranch,
        title,
        body,
        maintainer_can_modify: true,
        draft: false,
      });
      return { kind: "created", pullRequest: summarizeListedPullRequest(response.data), ...heads };
    } catch (error) {
      const createdDespiteError = await this.findPromotionPullRequest(heads.stageSha);
      if (createdDespiteError) return { kind: "reused", pullRequest: createdDespiteError, ...heads };
      throw error;
    }
  }

  async mergePromotionPullRequest(pullNumber: number): Promise<PullRequestMergeResult> {
    const pullRequest = await this.getPullRequest(pullNumber);
    if (pullRequest.head.ref !== config.baseBranch || pullRequest.base.ref !== "main") {
      return topologyBlocked(pullRequest, `Only ${config.baseBranch} -> main production promotion is supported`);
    }
    return await this.mergeInspectedPullRequest(pullRequest);
  }

  private async findOpenPullRequest(branch: string) {
    const response = await this.octokit.rest.pulls.list({
      owner: config.owner,
      repo: config.repo,
      state: "open",
      base: config.baseBranch,
      head: `${config.owner}:${branch}`,
      per_page: 10,
    });
    return response.data[0]?.html_url;
  }

  private async getPullRequest(pullNumber: number) {
    const response = await this.octokit.rest.pulls.get({
      owner: config.owner,
      repo: config.repo,
      pull_number: positiveInteger(pullNumber, "Pull request number"),
    });
    return response.data;
  }

  private async findPromotionPullRequest(stageSha: string) {
    const response = await this.octokit.rest.pulls.list({
      owner: config.owner,
      repo: config.repo,
      state: "all",
      base: "main",
      head: `${config.owner}:${config.baseBranch}`,
      per_page: 100,
    });
    const pullRequest = response.data.find((candidate) =>
      candidate.head.ref === config.baseBranch
      && candidate.head.sha === stageSha
      && candidate.base.ref === "main"
      && (candidate.state === "open" || candidate.merged_at !== null)
    );
    return pullRequest ? summarizeListedPullRequest(pullRequest) : null;
  }

  private async inspectPullRequestData(pullRequest: PullRequestData): Promise<PullRequestInspection> {
    const summary = summarizePullRequest(pullRequest);
    if (summary.merged) {
      return {
        pullRequest: summary,
        readiness: "already-merged",
        mergeable: pullRequest.mergeable,
        mergeableState: pullRequest.mergeable_state,
        mergeCommitSha: pullRequest.merge_commit_sha,
        checks: [],
        reviews: [],
        blockers: [],
      };
    }

    const blockers: PullRequestBlocker[] = [];
    if (summary.draft) blockers.push({ kind: "draft", detail: "Pull request is still a draft" });
    if (summary.state !== "open") blockers.push({ kind: "state", detail: "Pull request is closed without a merge" });
    if (pullRequest.mergeable === false || !mergeableStates.has(pullRequest.mergeable_state)) {
      if (pullRequest.mergeable !== null || pullRequest.mergeable_state !== "unknown") {
        blockers.push({
          kind: "mergeability",
          detail: `GitHub mergeability state is ${pullRequest.mergeable_state}`,
        });
      }
    }

    const checksResult = await this.availableGithubData(async () => {
      const response = await this.octokit.rest.checks.listForRef({
        owner: config.owner,
        repo: config.repo,
        ref: summary.headSha,
        filter: "latest",
        per_page: 100,
      });
      return response.data.check_runs.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        ...(check.html_url ? { url: check.html_url } : {}),
      }));
    });
    const checks = checksResult.data ?? [];
    if (!checksResult.available) {
      blockers.push({ kind: "unavailable", name: "checks", detail: "GitHub checks are unavailable" });
    } else {
      for (const check of checks) {
        if (check.status !== "completed" || !check.conclusion || !passingCheckConclusions.has(check.conclusion)) {
          blockers.push({
            kind: "check",
            name: check.name,
            detail: check.status === "completed"
              ? `Check concluded with ${check.conclusion ?? "no conclusion"}`
              : `Check is ${check.status}`,
          });
        }
      }
    }

    const reviewsResult = await this.availableGithubData(async () => {
      const response = await this.octokit.rest.pulls.listReviews({
        owner: config.owner,
        repo: config.repo,
        pull_number: summary.number,
        per_page: 100,
      });
      const latestByAuthor = new Map<string, { author: string; state: string; submittedAt: string | null }>();
      for (const review of response.data) {
        const author = review.user?.login ?? "unknown";
        latestByAuthor.set(author, {
          author,
          state: review.state,
          submittedAt: review.submitted_at ?? null,
        });
      }
      return [...latestByAuthor.values()];
    });
    const reviews = reviewsResult.data ?? [];
    if (!reviewsResult.available) {
      blockers.push({ kind: "unavailable", name: "reviews", detail: "GitHub reviews are unavailable" });
    } else {
      for (const review of reviews) {
        if (review.state === "CHANGES_REQUESTED") {
          blockers.push({ kind: "review", name: review.author, detail: "Reviewer requested changes" });
        }
      }
    }

    const unknown = pullRequest.mergeable === null || !checksResult.available || !reviewsResult.available;
    return {
      pullRequest: summary,
      readiness: blockers.length > 0 ? (unknown && blockers.every((item) => item.kind === "unavailable") ? "unknown" : "blocked")
        : unknown ? "unknown"
        : "ready",
      mergeable: pullRequest.mergeable,
      mergeableState: pullRequest.mergeable_state,
      mergeCommitSha: pullRequest.merge_commit_sha,
      checks,
      reviews,
      blockers,
    };
  }

  private async mergeInspectedPullRequest(pullRequest: PullRequestData): Promise<PullRequestMergeResult> {
    const inspection = await this.inspectPullRequestData(pullRequest);
    if (inspection.readiness === "already-merged") return mergedReplay(inspection);
    if (inspection.readiness !== "ready") {
      return {
        kind: inspection.readiness,
        pullRequestNumber: inspection.pullRequest.number,
        url: inspection.pullRequest.url,
        reason: inspection.blockers.map((blocker) => blocker.detail).join("; ") || "GitHub mergeability is unknown",
        inspection,
      };
    }

    try {
      const response = await this.octokit.rest.pulls.merge({
        owner: config.owner,
        repo: config.repo,
        pull_number: inspection.pullRequest.number,
        sha: inspection.pullRequest.headSha,
        merge_method: "merge",
      });
      if (response.data.merged) {
        return {
          kind: "merged",
          pullRequestNumber: inspection.pullRequest.number,
          url: inspection.pullRequest.url,
          mergeSha: response.data.sha,
        };
      }
      return {
        kind: "blocked",
        pullRequestNumber: inspection.pullRequest.number,
        url: inspection.pullRequest.url,
        reason: response.data.message || "GitHub refused the merge",
        inspection,
      };
    } catch (error) {
      const replay = await this.inspectPullRequest(inspection.pullRequest.number);
      if (replay.readiness === "already-merged") return mergedReplay(replay);
      if (new Set([405, 409, 422]).has((error as { status?: number }).status ?? 0)) {
        return {
          kind: replay.readiness === "unknown" ? "unknown" : "blocked",
          pullRequestNumber: replay.pullRequest.number,
          url: replay.pullRequest.url,
          reason: "GitHub refused the merge after rechecking current pull request state",
          inspection: replay,
        };
      }
      throw error;
    }
  }

  private async availableGithubData<T>(read: () => Promise<T>) {
    try {
      return { available: true as const, data: await read() };
    } catch (error) {
      if (new Set([403, 404]).has((error as { status?: number }).status ?? 0)) {
        return { available: false as const, data: undefined };
      }
      throw error;
    }
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

function summarizePullRequest(pullRequest: PullRequestData): PullRequestSummary {
  const state = pullRequestState(pullRequest.state);
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    state,
    draft: pullRequest.draft === true,
    merged: pullRequest.merged,
    headBranch: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    baseBranch: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
  };
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

function topologyBlocked(pullRequest: PullRequestData, reason: string): PullRequestMergeResult {
  return {
    kind: "blocked",
    pullRequestNumber: pullRequest.number,
    url: pullRequest.html_url,
    reason,
  };
}

function mergedReplay(inspection: PullRequestInspection): PullRequestMergeResult {
  if (!inspection.mergeCommitSha) {
    return {
      kind: "unknown",
      pullRequestNumber: inspection.pullRequest.number,
      url: inspection.pullRequest.url,
      reason: "GitHub reports the pull request merged without a merge commit SHA",
      inspection,
    };
  }
  return {
    kind: "already-merged",
    pullRequestNumber: inspection.pullRequest.number,
    url: inspection.pullRequest.url,
    mergeSha: inspection.mergeCommitSha,
  };
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
