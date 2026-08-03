import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PublicationArtifactReference } from "./artifact.js";
import {
  mergeReplayResult,
  reduceMergeOperation,
  type MergeOperation,
  type MergeOperationEvent,
  type MergeOperationTransition,
  type StagePullRequestCandidate,
} from "./merge.js";
import { ensurePrivateRuntimeDirectory, fsyncDirectory } from "./security.js";
import { sanitizeTaskView, type TaskView } from "./task-view.js";

export const MAX_MERGE_OPERATION_RECORDS = 100;

export type StalePublicationArtifact = {
  artifact: PublicationArtifactReference;
  detectedAt: string;
  reason: "base_changed";
};

export type IssueRunState = {
  issueNumber: number;
  branch: string;
  status: "running" | "awaiting_human" | "publish_pending" | "finished" | "failed";
  parentSessionId?: string;
  lastSessionId?: string;
  lastLogPath?: string;
  workspace?: string;
  baseSha?: string;
  awaitingAction?: "resume_child" | "retry_publish" | "rerun";
  pendingHumanReply?: string;
  humanQuestionCommentId?: number;
  humanLatestCommentId?: number;
  humanCommentResumeAfter?: string;
  taskView?: TaskView;
  publicationArtifact?: PublicationArtifactReference;
  stalePublicationArtifacts?: StalePublicationArtifact[];
  publishedCommitSha?: string;
  prNumber?: number;
  prUrl?: string;
  prHeadSha?: string;
  prMergedAt?: string;
  prMergeSha?: string;
  updatedAt: string;
};

type MergeClaimInput = Omit<Extract<MergeOperationEvent, { type: "claim" }>, "type">;
type MergeStartInput = Omit<Extract<MergeOperationEvent, { type: "start" }>, "type">;
type MergeCompletionEvent = Extract<MergeOperationEvent, { type: "block" | "retry" | "succeed" }>;
type MergeBlockInput = Omit<Extract<MergeCompletionEvent, { type: "block" }>, "type">;
type MergeRetryInput = Omit<Extract<MergeCompletionEvent, { type: "retry" }>, "type">;
type MergeSuccessInput = Omit<Extract<MergeCompletionEvent, { type: "succeed" }>, "type">;

export function nextRunAction(state?: IssueRunState) {
  if (state?.status === "finished" && state.prUrl) return "finalize" as const;
  if (
    state?.pendingHumanReply
    && state.awaitingAction === "resume_child"
    && state.lastSessionId
    && state.workspace
    && state.baseSha
  ) return "resume" as const;
  if (
    (state?.status === "publish_pending"
      || state?.status === "finished"
      || (state?.pendingHumanReply && state.awaitingAction === "retry_publish"))
    && state.publicationArtifact
  ) return "publish" as const;
  return "run" as const;
}

export function recoverStalePublication(
  state: IssueRunState,
  detectedAt: string,
): Omit<IssueRunState, "updatedAt"> {
  if (!state.publicationArtifact) throw new Error("Cannot recover a missing publication artifact");
  const detectedAtMs = Date.parse(detectedAt);
  if (Number.isNaN(detectedAtMs)) throw new Error("Invalid stale publication detection time");
  const suffix = `-fresh-${detectedAtMs.toString(36)}`;
  const branchPrefix = state.branch
    .slice(0, 240 - suffix.length)
    .replace(/[./]+$/, "");
  if (!branchPrefix) throw new Error("Cannot derive a fresh publication branch");
  const {
    updatedAt: _updatedAt,
    publicationArtifact,
    publishedCommitSha: _publishedCommitSha,
    prNumber: _prNumber,
    prUrl: _prUrl,
    prHeadSha: _prHeadSha,
    prMergedAt: _prMergedAt,
    prMergeSha: _prMergeSha,
    ...rest
  } = state;
  return {
    ...rest,
    branch: `${branchPrefix}${suffix}`,
    status: "awaiting_human",
    awaitingAction: "rerun",
    stalePublicationArtifacts: [
      ...(state.stalePublicationArtifacts ?? []),
      { artifact: publicationArtifact, detectedAt, reason: "base_changed" },
    ],
  };
}

export function activeRunForParent(states: IssueRunState[], parentSessionId: string) {
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)) {
    throw new Error("Invalid OpenCode parent session ID");
  }
  const matches = states
    .filter((state) => state.parentSessionId === parentSessionId && state.status !== "finished")
    .sort((left, right) => left.issueNumber - right.issueNumber);
  if (matches.length > 1) {
    throw new Error("Multiple unfinished Issues share one OpenCode parent session");
  }
  return matches[0];
}

export class StateStore {
  private readonly filePath: string;
  private states = new Map<number, IssueRunState>();
  private mergeOperations = new Map<string, MergeOperation>();
  private writeChain = Promise.resolve();
  private readonly operationChains = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "state", "runs.json");
  }

  async load() {
    await ensurePrivateRuntimeDirectory(path.dirname(this.filePath));
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      const runs = Array.isArray(parsed)
        ? parsed
        : isStateEnvelopeV2(parsed) || isStateEnvelopeV3(parsed)
          ? parsed.runs
          : undefined;
      if (!runs) throw new Error("runs.json must be a legacy array or supported state envelope");
      const validated = runs.map(validateRunState);
      this.states = new Map(validated.map((item) => [item.issueNumber, item]));
      const operations = isStateEnvelopeV3(parsed)
        ? parsed.mergeOperations.map(validateMergeOperation)
        : [];
      this.mergeOperations = uniqueMergeOperations(operations);
      this.pruneMergeOperations(MAX_MERGE_OPERATION_RECORDS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(issueNumber: number) {
    return this.states.get(issueNumber);
  }

  all() {
    return [...this.states.values()].sort((left, right) => left.issueNumber - right.issueNumber);
  }

  getByParentSession(parentSessionId: string) {
    return activeRunForParent([...this.states.values()], parentSessionId);
  }

  getCompletedIssue(parentSessionId: string, issueNumber?: number) {
    validateParentSessionId(parentSessionId);
    if (issueNumber !== undefined && (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)) {
      throw new Error("Invalid Issue selector");
    }
    const matches = [...this.states.values()]
      .filter((state) => (
        state.parentSessionId === parentSessionId
        && state.status === "finished"
        && (issueNumber === undefined || state.issueNumber === issueNumber)
      ))
      .sort((left, right) => left.issueNumber - right.issueNumber);
    if (matches.length > 1) {
      throw new Error("Multiple completed Issues share one OpenCode parent session; an exact Issue selector is required");
    }
    return matches[0];
  }

  getEligibleStagePullRequestCandidates(
    parentSessionId: string,
    issueNumber?: number,
  ): StagePullRequestCandidate[] {
    validateParentSessionId(parentSessionId);
    if (issueNumber !== undefined && (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)) {
      throw new Error("Invalid Issue selector");
    }
    return [...this.states.values()]
      .filter((state) => (
        state.parentSessionId === parentSessionId
        && state.status === "finished"
        && state.prMergedAt === undefined
        && state.prNumber !== undefined
        && state.prUrl !== undefined
        && state.prHeadSha !== undefined
        && (issueNumber === undefined || state.issueNumber === issueNumber)
      ))
      .sort((left, right) => (left.prNumber as number) - (right.prNumber as number))
      .map((state) => ({
        prNumber: state.prNumber as number,
        issueNumber: state.issueNumber,
        sessionId: parentSessionId,
        headSha: state.prHeadSha as string,
        baseBranch: "stage",
        state: "open",
      }));
  }

  getMergeOperation(operationKey: string) {
    return this.mergeOperations.get(operationKey);
  }

  allMergeOperations() {
    return this.sortedMergeOperations();
  }

  listRecoverableMergeOperations() {
    return this.sortedMergeOperations().filter((operation) => (
      operation.status === "claimed" || operation.status === "running"
    ));
  }

  async set(state: Omit<IssueRunState, "updatedAt">) {
    const next = validateRunState({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    this.states.set(next.issueNumber, next);
    await this.persist();
  }

  async claimMergeOperation(input: MergeClaimInput): Promise<MergeOperationTransition> {
    return this.transitionMergeOperation(input.operationKey, { type: "claim", ...input });
  }

  async startMergeOperation(
    operationKey: string,
    input: MergeStartInput,
  ): Promise<MergeOperationTransition> {
    return this.transitionMergeOperation(operationKey, { type: "start", ...input });
  }

  async completeMergeOperation(
    operationKey: string,
    event: MergeCompletionEvent,
  ): Promise<MergeOperationTransition> {
    return this.transitionMergeOperation(operationKey, event);
  }

  async blockMergeOperation(
    operationKey: string,
    input: MergeBlockInput,
  ): Promise<MergeOperationTransition> {
    return this.completeMergeOperation(operationKey, { type: "block", ...input });
  }

  async retryMergeOperation(
    operationKey: string,
    input: MergeRetryInput,
  ): Promise<MergeOperationTransition> {
    return this.completeMergeOperation(operationKey, { type: "retry", ...input });
  }

  async succeedMergeOperation(
    operationKey: string,
    input: MergeSuccessInput,
  ): Promise<MergeOperationTransition> {
    return this.completeMergeOperation(operationKey, { type: "succeed", ...input });
  }

  private async transitionMergeOperation(
    operationKey: string,
    event: MergeOperationEvent,
  ): Promise<MergeOperationTransition> {
    return this.withOperationKey(operationKey, async () => {
      const current = this.mergeOperations.get(operationKey);
      if (!current && event.type === "claim" && !this.reserveMergeOperationRecord()) {
        return { kind: "rejected", reason: "Merge operation audit capacity is exhausted by active operations" };
      }
      const transition = reduceMergeOperation(current, event);
      if (transition.kind !== "transitioned") return transition;
      const operation = validateMergeOperation(transition.operation);
      this.mergeOperations.set(operation.key, operation);
      this.pruneMergeOperations(MAX_MERGE_OPERATION_RECORDS);
      await this.persist();
      return { ...transition, operation };
    });
  }

  private async withOperationKey<T>(operationKey: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operationChains.get(operationKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.operationChains.set(operationKey, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.operationChains.get(operationKey) === tail) this.operationChains.delete(operationKey);
    }
  }

  private reserveMergeOperationRecord() {
    if (this.mergeOperations.size < MAX_MERGE_OPERATION_RECORDS) return true;
    this.pruneMergeOperations(MAX_MERGE_OPERATION_RECORDS - 1);
    return this.mergeOperations.size < MAX_MERGE_OPERATION_RECORDS;
  }

  private pruneMergeOperations(limit: number) {
    if (this.mergeOperations.size <= limit) return;
    const removable = this.sortedMergeOperations()
      .filter((operation) => operation.status !== "claimed" && operation.status !== "running");
    for (const operation of removable) {
      if (this.mergeOperations.size <= limit) break;
      this.mergeOperations.delete(operation.key);
    }
  }

  private sortedMergeOperations() {
    return [...this.mergeOperations.values()].sort((left, right) => (
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.key.localeCompare(right.key)
    ));
  }

  private async persist() {
    const write = this.writeChain.then(() => this.flush());
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private async flush() {
    const runs = [...this.states.values()].sort((left, right) => left.issueNumber - right.issueNumber);
    const mergeOperations = this.sortedMergeOperations();
    const payload = JSON.stringify({ schemaVersion: 3, runs, mergeOperations }, null, 2);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${payload}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.rename(temporary, this.filePath);
      await fsyncDirectory(path.dirname(this.filePath));
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}

function isStateEnvelopeV2(value: unknown): value is { schemaVersion: 2; runs: unknown[] } {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { schemaVersion?: unknown }).schemaVersion === 2
    && Array.isArray((value as { runs?: unknown }).runs),
  );
}

function isStateEnvelopeV3(
  value: unknown,
): value is { schemaVersion: 3; runs: unknown[]; mergeOperations: unknown[] } {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { schemaVersion?: unknown }).schemaVersion === 3
    && Array.isArray((value as { runs?: unknown }).runs)
    && Array.isArray((value as { mergeOperations?: unknown }).mergeOperations),
  );
}

function validateRunState(value: unknown): IssueRunState {
  if (!value || typeof value !== "object") throw new Error("Invalid issue run state");
  const state = value as Partial<IssueRunState>;
  if (Object.keys(state).some((key) => /token|password|secret|private.?key|credential/i.test(key))) {
    throw new Error("Issue run state must not contain credentials");
  }
  const statuses = new Set<IssueRunState["status"]>([
    "running",
    "awaiting_human",
    "publish_pending",
    "finished",
    "failed",
  ]);
  if (
    !Number.isSafeInteger(state.issueNumber)
    || (state.issueNumber ?? 0) <= 0
    || typeof state.branch !== "string"
    || state.branch.length === 0
    || !state.status
    || !statuses.has(state.status)
    || typeof state.updatedAt !== "string"
    || Number.isNaN(Date.parse(state.updatedAt))
  ) {
    throw new Error("Invalid issue run state fields");
  }
  if (state.stalePublicationArtifacts !== undefined) {
    if (!Array.isArray(state.stalePublicationArtifacts) || state.stalePublicationArtifacts.length > 100) {
      throw new Error("Invalid stale publication artifact audit");
    }
    for (const entry of state.stalePublicationArtifacts) {
      if (
        !entry
        || typeof entry !== "object"
        || entry.reason !== "base_changed"
        || typeof entry.detectedAt !== "string"
        || Number.isNaN(Date.parse(entry.detectedAt))
        || !entry.artifact
        || typeof entry.artifact.manifestPath !== "string"
        || !/^[0-9a-f]{64}$/.test(entry.artifact.manifestSha256)
      ) {
        throw new Error("Invalid stale publication artifact entry");
      }
    }
  }
  for (const sessionId of [state.parentSessionId, state.lastSessionId]) {
    if (sessionId !== undefined && !/^ses_[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
      throw new Error("Invalid OpenCode session ID");
    }
  }
  if (state.workspace !== undefined && (
    typeof state.workspace !== "string"
    || !path.isAbsolute(state.workspace)
    || state.workspace.length > 4_096
  )) throw new Error("Invalid OpenCode workspace path");
  if (state.baseSha !== undefined && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(state.baseSha)) {
    throw new Error("Invalid base SHA");
  }
  if (state.prNumber !== undefined && (
    !Number.isSafeInteger(state.prNumber)
    || state.prNumber <= 0
  )) throw new Error("Invalid pull request number");
  if (state.prUrl !== undefined) validateCredentialFreeHttpsUrl(state.prUrl, "Pull request URL");
  if (state.prHeadSha !== undefined && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(state.prHeadSha)) {
    throw new Error("Invalid pull request head SHA");
  }
  if (state.prMergedAt !== undefined && (
    typeof state.prMergedAt !== "string"
    || Number.isNaN(Date.parse(state.prMergedAt))
  )) throw new Error("Invalid pull request merge time");
  if (state.prMergeSha !== undefined && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(state.prMergeSha)) {
    throw new Error("Invalid pull request merge SHA");
  }
  if ((state.prMergedAt === undefined) !== (state.prMergeSha === undefined)) {
    throw new Error("Pull request merge metadata must include both time and SHA");
  }
  if (
    state.awaitingAction !== undefined
    && !new Set(["resume_child", "retry_publish", "rerun"]).has(state.awaitingAction)
  ) throw new Error("Invalid awaiting action");
  if (state.pendingHumanReply !== undefined && (
    typeof state.pendingHumanReply !== "string"
    || state.pendingHumanReply.trim().length === 0
    || state.pendingHumanReply.length > 16_000
  )) throw new Error("Invalid pending human reply");
  if (state.humanQuestionCommentId !== undefined && (
    !Number.isSafeInteger(state.humanQuestionCommentId)
    || state.humanQuestionCommentId <= 0
  )) throw new Error("Invalid human question comment ID");
  if (state.humanLatestCommentId !== undefined && (
    state.humanQuestionCommentId === undefined
    || !Number.isSafeInteger(state.humanLatestCommentId)
    || state.humanLatestCommentId <= state.humanQuestionCommentId
  )) throw new Error("Invalid latest human comment ID");
  if (state.humanCommentResumeAfter !== undefined && (
    state.humanLatestCommentId === undefined
    || typeof state.humanCommentResumeAfter !== "string"
    || Number.isNaN(Date.parse(state.humanCommentResumeAfter))
  )) throw new Error("Invalid human comment resume time");
  if (state.taskView !== undefined) state.taskView = sanitizeTaskView(state.taskView);
  return state as IssueRunState;
}

function validateMergeOperation(value: unknown): MergeOperation {
  if (!value || typeof value !== "object") throw new Error("Invalid merge operation");
  const operation = value as MergeOperation;
  const statuses = new Set(["claimed", "running", "succeeded", "blocked", "retryable"]);
  if (!statuses.has(operation.status) || !Array.isArray(operation.audit)) {
    throw new Error("Invalid merge operation fields");
  }
  for (const entry of operation.audit) {
    if (!entry || typeof entry !== "object" || !statuses.has(entry.action)) {
      throw new Error("Invalid merge operation audit entry");
    }
  }
  const normalized: MergeOperation = {
    key: operation.key,
    target: operation.target,
    stageSha: operation.stageSha,
    ...(operation.issueNumber === undefined ? {} : { issueNumber: operation.issueNumber }),
    ...(operation.prNumber === undefined ? {} : { prNumber: operation.prNumber }),
    status: operation.status,
    claimant: operation.claimant,
    attempt: operation.attempt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    audit: operation.audit.map((entry) => ({
      at: entry.at,
      actor: entry.actor,
      action: entry.action,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    })),
    ...(operation.failureReason === undefined ? {} : { failureReason: operation.failureReason }),
    ...(operation.result === undefined ? {} : {
      result: {
        mergeSha: operation.result.mergeSha,
        pullRequestNumber: operation.result.pullRequestNumber,
        ...(operation.result.url === undefined ? {} : { url: operation.result.url }),
      },
    }),
  };
  mergeReplayResult(normalized);
  if (normalized.result?.url) validateCredentialFreeHttpsUrl(normalized.result.url, "Merge result URL");
  return normalized;
}

function uniqueMergeOperations(operations: MergeOperation[]) {
  const unique = new Map<string, MergeOperation>();
  for (const operation of operations) {
    if (unique.has(operation.key)) throw new Error("Duplicate merge operation key");
    unique.set(operation.key, operation);
  }
  return unique;
}

function validateParentSessionId(parentSessionId: string) {
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)) {
    throw new Error("Invalid OpenCode parent session ID");
  }
}

function validateCredentialFreeHttpsUrl(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 2_048) throw new Error(`Invalid ${label}`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
}
