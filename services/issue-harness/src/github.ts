import { Octokit } from "@octokit/rest";
import { config } from "./env.js";
import { labelColors, labels, statusLabels } from "./labels.js";

export type TrackerIssue = Awaited<ReturnType<GithubTracker["nextIssue"]>>;

export class GithubTracker {
  private readonly octokit = new Octokit({ auth: config.githubToken });

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
            `GitHub repository ${config.owner}/${config.repo} was not found or the token cannot access it.`,
            "Check GITHUB_OWNER/GITHUB_REPO spelling, make sure the repository exists, and ensure the PAT is scoped to this repository.",
            "For a fine-grained PAT, grant Metadata read, Contents read/write, Issues read/write, and Pull requests read/write.",
          ].join(" "),
        );
      }
      throw error;
    }
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
    const candidates = [...todo, ...running].filter((issue) => {
      const issueLabels = issue.labels.map((label) => (typeof label === "string" ? label : label.name));
      return !issue.pull_request && !issueLabels.includes(labels.needsHuman) && !issueLabels.includes(labels.finished);
    });
    return candidates[0] ?? null;
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
          !body.startsWith("Codex picked this up on branch") &&
          !body.startsWith("Human attention needed:\n\nCodex run failed before finishing.")
        );
      })
      .slice(-10)
      .map((comment) => `@${comment.user?.login ?? "unknown"}: ${comment.body ?? ""}`)
      .join("\n\n---\n\n");
  }

  async moveStatus(issueNumber: number, status: keyof Pick<typeof labels, "todo" | "running" | "finished">) {
    for (const label of statusLabels) {
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

    await this.octokit.rest.issues.addLabels({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      labels: [labels[status]],
    });
  }

  async needsHuman(issueNumber: number, body: string) {
    await this.octokit.rest.issues.addLabels({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      labels: [labels.needsHuman],
    });
    await this.comment(issueNumber, `Human attention needed:\n\n${body}`);
  }

  async comment(issueNumber: number, body: string) {
    await this.octokit.rest.issues.createComment({
      owner: config.owner,
      repo: config.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async createPullRequest(issueNumber: number, branch: string, title: string, body: string) {
    const pr = await this.octokit.rest.pulls.create({
      owner: config.owner,
      repo: config.repo,
      base: config.baseBranch,
      head: branch,
      title: `Fix #${issueNumber}: ${title}`,
      body,
      maintainer_can_modify: true,
    });
    return pr.data.html_url;
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
