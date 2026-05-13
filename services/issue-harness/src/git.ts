import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./env.js";

const execFileAsync = promisify(execFile);

export async function pushBranch(branch: string) {
  const remoteUrl = `https://x-access-token:${encodeURIComponent(config.githubToken)}@github.com/${config.owner}/${config.repo}.git`;
  await execFileAsync("git", ["push", "-u", remoteUrl, branch], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 10,
  });
}

export function branchName(issueNumber: number, title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `codex/issue-${issueNumber}-${slug || "task"}`;
}
