export function branchName(issueNumber: number, title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `opencode/issue-${issueNumber}-${slug || "task"}`;
}
