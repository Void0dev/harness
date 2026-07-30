const SESSION_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MAX_ISSUE_TEXT_LENGTH = 50_000;

export function buildIssueRequest(options: { text: string; parentSessionId: string }) {
  const text = options.text.trim();
  if (!text) throw new Error("Issue text is required after /issue");
  if (text.length > MAX_ISSUE_TEXT_LENGTH) throw new Error("Issue text is too long");
  if (!SESSION_ID.test(options.parentSessionId)) {
    throw new Error("Invalid OpenCode parent session ID");
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? text;
  return {
    title: firstLine.slice(0, 120),
    body: `${text}\n\n<!-- opencode-harness-parent: ${options.parentSessionId} -->`,
    labels: ["ai:todo"],
  };
}
