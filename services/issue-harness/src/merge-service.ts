import type {
  GithubTracker,
  PromotionPullRequestResult,
  PullRequestMergeResult,
  PullRequestSummary,
} from "./github.js";
import {
  mergeOperationKey,
  parseMergeSelection,
  productionOperationKey,
  selectEligibleStagePullRequest,
  type MergeReplayResult,
  type MergeTarget,
} from "./merge.js";
import { StateStore, type IssueRunState } from "./state.js";

export type ExplicitMergeRequest = {
  parentSessionId: string;
  argumentsText: string;
  requestedBy: string;
};

export type ExplicitMergeOutcome = {
  status: "merged" | "already-merged" | "ambiguous" | "no-candidate" | "blocked" | "failed";
  target: MergeTarget;
  pullRequestNumber?: number;
  mergeSha?: string;
  url?: string;
  reason?: string;
  candidates?: Array<{ issueNumber: number; prNumber: number }>;
};

type MergeGithub = Pick<GithubTracker,
  | "findHarnessPullRequest"
  | "markStagePullRequestReady"
  | "mergeStagePullRequest"
  | "readReleaseHeads"
  | "findOrCreatePromotionPullRequest"
  | "mergePromotionPullRequest"
  | "inspectPullRequest"
>;

export class MergeService {
  constructor(
    private readonly state: StateStore,
    private readonly github: MergeGithub,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async submit(request: ExplicitMergeRequest): Promise<ExplicitMergeOutcome> {
    let selection;
    try {
      selection = parseMergeSelection(request.argumentsText);
    } catch (error) {
      return {
        status: "failed",
        target: request.argumentsText.trim().toLowerCase().startsWith("prod") ? "prod" : "stage",
        reason: error instanceof Error ? error.message : "Invalid merge request",
      };
    }
    try {
      return selection.target === "stage"
        ? await this.mergeStage(request, selection.issueNumber)
        : await this.mergeProduction(request);
    } catch {
      return { status: "failed", target: selection.target, reason: "GitHub merge request failed" };
    }
  }

  async recoverIncompleteOperations() {
    for (const operation of this.state.listRecoverableMergeOperations()) {
      const inspected = operation.prNumber
        ? await this.github.inspectPullRequest(operation.prNumber)
        : undefined;
      if (inspected?.readiness === "already-merged" && inspected.mergeCommitSha) {
        if (operation.status === "claimed") {
          const started = await this.state.startMergeOperation(operation.key, {
            actor: operation.claimant,
            at: this.now(),
          });
          if (started.kind === "rejected") continue;
        }
        await this.state.succeedMergeOperation(operation.key, {
          actor: operation.claimant,
          at: this.now(),
          mergeSha: inspected.mergeCommitSha,
          pullRequestNumber: inspected.pullRequest.number,
          url: inspected.pullRequest.url,
        });
        if (operation.target === "stage" && operation.issueNumber) {
          await this.markIssueMerged(operation.issueNumber, inspected.mergeCommitSha);
        }
        continue;
      }
      await this.state.retryMergeOperation(operation.key, {
        actor: operation.claimant,
        at: this.now(),
        reason: "Recovered unfinished merge operation; explicit retry is required",
      });
    }
  }

  private async mergeStage(request: ExplicitMergeRequest, issueNumber?: number): Promise<ExplicitMergeOutcome> {
    await this.hydrateStagePullRequests(request.parentSessionId, issueNumber);
    const candidates = this.state.getEligibleStagePullRequestCandidates(request.parentSessionId, issueNumber);
    const selected = selectEligibleStagePullRequest({
      sessionId: request.parentSessionId,
      issueNumber,
      candidates,
    });
    if (selected.kind === "none") return { status: "no-candidate", target: "stage" };
    if (selected.kind === "ambiguous") {
      return {
        status: "ambiguous",
        target: "stage",
        candidates: selected.candidates.map((candidate) => ({
          issueNumber: candidate.issueNumber,
          prNumber: candidate.prNumber,
        })),
      };
    }

    const candidate = selected.candidate;
    const operationKey = mergeOperationKey({
      target: "stage",
      stageSha: candidate.headSha,
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
    });
    const claim = await this.state.claimMergeOperation({
      operationKey,
      target: "stage",
      stageSha: candidate.headSha,
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      actor: request.requestedBy,
      at: this.now(),
    });
    const replay = replayOutcome("stage", claim);
    if (replay) return replay;
    const started = await this.state.startMergeOperation(operationKey, {
      actor: request.requestedBy,
      at: this.now(),
    });
    if (started.kind === "replay") return mapReplay("stage", started.replay);
    if (started.kind === "rejected") return { status: "failed", target: "stage", reason: started.reason };

    const ready = await this.github.markStagePullRequestReady(candidate.prNumber);
    if (ready.kind === "blocked") {
      return await this.retryableBlock(operationKey, request.requestedBy, "stage", ready.reason, candidate.prNumber, ready.url);
    }
    const merged = await this.github.mergeStagePullRequest(candidate.prNumber);
    const outcome = await this.completeRemoteMerge(operationKey, request.requestedBy, "stage", merged);
    if (outcome.status === "merged" || outcome.status === "already-merged") {
      await this.markIssueMerged(candidate.issueNumber, outcome.mergeSha as string);
    }
    return outcome;
  }

  private async mergeProduction(request: ExplicitMergeRequest): Promise<ExplicitMergeOutcome> {
    const promotion = await this.github.findOrCreatePromotionPullRequest(
      "Promote stage to production",
      `Explicit production promotion requested by ${request.requestedBy}.`,
    );
    if (promotion.kind === "already-promoted") return { status: "no-candidate", target: "prod" };
    const operationKey = productionOperationKey(promotion.stageSha);
    const claim = await this.state.claimMergeOperation({
      operationKey,
      target: "prod",
      stageSha: promotion.stageSha,
      prNumber: promotion.pullRequest.number,
      actor: request.requestedBy,
      at: this.now(),
    });
    const replay = replayOutcome("prod", claim);
    if (replay) return replay;
    const started = await this.state.startMergeOperation(operationKey, {
      actor: request.requestedBy,
      at: this.now(),
    });
    if (started.kind === "replay") return mapReplay("prod", started.replay);
    if (started.kind === "rejected") return { status: "failed", target: "prod", reason: started.reason };

    return await this.completePromotion(operationKey, request.requestedBy, promotion);
  }

  private async completePromotion(
    operationKey: string,
    actor: string,
    promotion: Extract<PromotionPullRequestResult, { kind: "created" | "reused" }>,
  ) {
    const merged = await this.github.mergePromotionPullRequest(promotion.pullRequest.number);
    return await this.completeRemoteMerge(operationKey, actor, "prod", merged);
  }

  private async completeRemoteMerge(
    operationKey: string,
    actor: string,
    target: MergeTarget,
    result: PullRequestMergeResult,
  ): Promise<ExplicitMergeOutcome> {
    if ("mergeSha" in result) {
      const transition = await this.state.succeedMergeOperation(operationKey, {
        actor,
        at: this.now(),
        mergeSha: result.mergeSha,
        pullRequestNumber: result.pullRequestNumber,
        url: result.url,
      });
      if (transition.kind === "replay") return mapReplay(target, transition.replay);
      if (transition.kind === "rejected") return { status: "failed", target, reason: transition.reason };
      return {
        status: result.kind,
        target,
        pullRequestNumber: result.pullRequestNumber,
        mergeSha: result.mergeSha,
        url: result.url,
      };
    }
    return await this.retryableBlock(
      operationKey,
      actor,
      target,
      result.reason,
      result.pullRequestNumber,
      result.url,
    );
  }

  private async retryableBlock(
    operationKey: string,
    actor: string,
    target: MergeTarget,
    reason: string,
    pullRequestNumber?: number,
    url?: string,
  ): Promise<ExplicitMergeOutcome> {
    await this.state.retryMergeOperation(operationKey, { actor, at: this.now(), reason });
    return { status: "blocked", target, reason, pullRequestNumber, url };
  }

  private async hydrateStagePullRequests(parentSessionId: string, issueNumber?: number) {
    const runs = this.state.all().filter((run) => (
      run.parentSessionId === parentSessionId
      && run.status === "finished"
      && run.prMergedAt === undefined
      && (issueNumber === undefined || run.issueNumber === issueNumber)
    ));
    for (const run of runs) {
      if (run.prNumber && run.prHeadSha && run.prUrl) continue;
      const pullRequest = await this.github.findHarnessPullRequest(run.issueNumber, run.branch);
      if (!pullRequest || pullRequest.merged) continue;
      await this.state.set({
        ...withoutTimestamp(run),
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
        prHeadSha: pullRequest.headSha,
      });
    }
  }

  private async markIssueMerged(issueNumber: number, mergeSha: string) {
    const run = this.state.get(issueNumber);
    if (!run) return;
    await this.state.set({
      ...withoutTimestamp(run),
      prMergedAt: this.now(),
      prMergeSha: mergeSha,
    });
  }
}

function replayOutcome(
  target: MergeTarget,
  transition: Awaited<ReturnType<StateStore["claimMergeOperation"]>>,
): ExplicitMergeOutcome | undefined {
  if (transition.kind === "transitioned") return undefined;
  if (transition.kind === "rejected") return { status: "failed", target, reason: transition.reason };
  return mapReplay(target, transition.replay);
}

function mapReplay(target: MergeTarget, replay: MergeReplayResult): ExplicitMergeOutcome {
  if (replay.kind === "already-merged") {
    return {
      status: "already-merged",
      target,
      pullRequestNumber: replay.pullRequestNumber,
      mergeSha: replay.mergeSha,
      ...(replay.url ? { url: replay.url } : {}),
    };
  }
  return {
    status: "blocked",
    target,
    reason: replay.kind === "in-progress"
      ? "The same merge operation is already in progress"
      : replay.reason,
  };
}

function withoutTimestamp(run: IssueRunState): Omit<IssueRunState, "updatedAt"> {
  const { updatedAt: _updatedAt, ...persisted } = run;
  return persisted;
}
