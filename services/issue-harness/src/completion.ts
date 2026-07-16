export const COMPLETION_MARKER = "<promise>COMPLETE</promise>";

export function extractHumanQuestion(stdout: string) {
  const match = stdout.match(/<human-attention>([\s\S]*?)<\/human-attention>/i);
  return match?.[1]?.trim();
}

export function assertAgentRunPublishable(options: {
  stdout: string;
  completionSignal?: string;
  hasBranchCommits: boolean;
}) {
  if (extractHumanQuestion(options.stdout)) return;
  if (options.completionSignal !== COMPLETION_MARKER) {
    throw new Error("Codex stopped without the required completion signal; refusing to publish partial work");
  }
  if (!options.hasBranchCommits) {
    throw new Error("Codex completed without a commit ahead of the base branch; refusing to publish an empty branch");
  }
}
