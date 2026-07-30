export const COMPLETION_MARKER = "<promise>COMPLETE</promise>";

export function hasHumanAttention(stdout: string) {
  return /<human-attention>[\s\S]*?<\/human-attention>/i.test(stdout);
}

export function humanAttentionQuestion(stdout: string) {
  const match = /<human-attention>([\s\S]*?)<\/human-attention>/i.exec(stdout);
  const question = match?.[1]?.trim();
  return question ? question.slice(0, 4_000) : undefined;
}

export function assertAgentRunPublishable(options: {
  stdout: string;
  completionSignal?: string;
  hasBranchCommits: boolean;
}) {
  if (hasHumanAttention(options.stdout)) return;
  if (options.completionSignal !== COMPLETION_MARKER) {
    throw new Error("OpenCode stopped without the required completion signal; refusing to publish partial work");
  }
  if (!options.hasBranchCommits) {
    throw new Error("OpenCode completed without a commit ahead of the base branch; refusing to publish an empty branch");
  }
}
