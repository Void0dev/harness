import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pushBranch(branch: string) {
  await execFileAsync("git", ["push", "-u", "origin", branch], {
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
