export type PollResult =
  | "processed"
  | "empty"
  | "capacity-reached"
  | "claim-in-progress"
  | "already-claimed";

export class RunScheduler<T> {
  private activeRuns = 0;
  private claimInProgress = false;
  private readonly claimed = new Set<string | number>();

  constructor(
    private readonly maxConcurrentRuns: number,
    private readonly issueKey: (issue: T) => string | number,
  ) {
    if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
      throw new Error("maxConcurrentRuns must be a positive integer");
    }
  }

  async poll(
    nextIssue: () => Promise<T | null | undefined>,
    processIssue: (issue: T) => Promise<void>,
  ): Promise<PollResult> {
    if (this.claimInProgress) return "claim-in-progress";
    if (this.activeRuns >= this.maxConcurrentRuns) return "capacity-reached";

    this.claimInProgress = true;
    let issue: T | null | undefined;
    try {
      issue = await nextIssue();
    } finally {
      this.claimInProgress = false;
    }
    if (!issue) return "empty";

    const key = this.issueKey(issue);
    if (this.claimed.has(key)) return "already-claimed";
    this.claimed.add(key);
    this.activeRuns += 1;
    try {
      await processIssue(issue);
    } finally {
      this.activeRuns -= 1;
      this.claimed.delete(key);
    }
    return "processed";
  }
}
