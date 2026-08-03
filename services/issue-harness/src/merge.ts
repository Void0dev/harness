export const MAX_MERGE_AUDIT_ENTRIES = 50;
export const MAX_MERGE_AUDIT_DETAIL_LENGTH = 2_000;
export const MAX_MERGE_ACTOR_LENGTH = 128;
export const MAX_MERGE_URL_LENGTH = 2_048;

export type MergeTarget = "stage" | "prod";

export interface MergeSelection {
  target: MergeTarget;
  issueNumber?: number;
}

export type MergeSelectionInput = string | {
  target: string;
  issue?: string | number;
};

export function parseMergeSelection(input: MergeSelectionInput): MergeSelection {
  if (typeof input === "string") {
    const parts = input.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 2) throw new Error("Invalid merge selection");
    return parseMergeSelection({ target: parts[0], issue: parts[1] });
  }

  const target = normalizeTarget(input.target);
  if (input.issue === undefined) return { target };
  if (target === "prod") throw new Error("Production merge does not accept an Issue selector");
  return { target, issueNumber: parseIssueSelector(input.issue) };
}

export const parseMergeTarget = parseMergeSelection;

export interface StagePullRequestCandidate {
  prNumber: number;
  issueNumber: number;
  sessionId: string;
  headSha: string;
  baseBranch: string;
  state: "open" | "closed";
  draft?: boolean;
  mergeable?: boolean;
  merged?: boolean;
}

export type StagePullRequestSelection =
  | { kind: "selected"; candidate: StagePullRequestCandidate }
  | { kind: "none"; reason: "no-eligible-stage-pr" }
  | {
      kind: "ambiguous";
      reason: "multiple-eligible-stage-prs";
      candidates: StagePullRequestCandidate[];
    };

export function selectEligibleStagePullRequest(options: {
  sessionId: string;
  issueNumber?: number;
  candidates: readonly StagePullRequestCandidate[];
}): StagePullRequestSelection {
  const eligible = options.candidates
    .filter((candidate) => (
      candidate.sessionId === options.sessionId
      && candidate.baseBranch === "stage"
      && candidate.state === "open"
      && candidate.draft !== true
      && candidate.mergeable !== false
      && candidate.merged !== true
      && (options.issueNumber === undefined || candidate.issueNumber === options.issueNumber)
    ))
    .slice()
    .sort((left, right) => left.prNumber - right.prNumber);

  if (eligible.length === 0) return { kind: "none", reason: "no-eligible-stage-pr" };
  if (eligible.length > 1) {
    return { kind: "ambiguous", reason: "multiple-eligible-stage-prs", candidates: eligible };
  }
  return { kind: "selected", candidate: eligible[0] };
}

export const selectStagePullRequest = selectEligibleStagePullRequest;

export function productionOperationKey(stageSha: string) {
  return `merge:prod:${normalizeSha(stageSha)}`;
}

export const productionMergeOperationKey = productionOperationKey;

export function mergeOperationKey(options: {
  target: MergeTarget;
  stageSha: string;
  prNumber?: number;
  issueNumber?: number;
}) {
  if (options.target === "prod") return productionOperationKey(options.stageSha);
  const issueNumber = positiveInteger(options.issueNumber, "Issue number");
  const prNumber = positiveInteger(options.prNumber, "Stage pull request number");
  return `merge:stage:${issueNumber}:${prNumber}:${normalizeSha(options.stageSha)}`;
}

export const deterministicMergeOperationKey = mergeOperationKey;

export type MergeOperationStatus = "claimed" | "running" | "succeeded" | "blocked" | "retryable";

export interface MergeAuditEntry {
  at: string;
  actor: string;
  action: MergeOperationStatus;
  detail?: string;
}

export interface MergeSuccess {
  mergeSha: string;
  pullRequestNumber: number;
  url?: string;
}

export interface MergeOperation {
  key: string;
  target: MergeTarget;
  stageSha: string;
  issueNumber?: number;
  prNumber?: number;
  status: MergeOperationStatus;
  claimant: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  audit: MergeAuditEntry[];
  failureReason?: string;
  result?: MergeSuccess;
}

export type MergeReplayResult =
  | { kind: "in-progress"; operationKey: string; status: "claimed" | "running"; claimant: string }
  | { kind: "already-merged"; operationKey: string; mergeSha: string; pullRequestNumber: number; url?: string }
  | { kind: "blocked"; operationKey: string; reason: string }
  | { kind: "retryable"; operationKey: string; reason: string };

export function mergeReplayResult(operation: MergeOperation): MergeReplayResult {
  validateOperation(operation);
  if (operation.status === "claimed" || operation.status === "running") {
    return {
      kind: "in-progress",
      operationKey: operation.key,
      status: operation.status,
      claimant: operation.claimant,
    };
  }
  if (operation.status === "succeeded") {
    if (!operation.result) throw new Error("Succeeded merge operation requires a result");
    return {
      kind: "already-merged",
      operationKey: operation.key,
      mergeSha: operation.result.mergeSha,
      pullRequestNumber: operation.result.pullRequestNumber,
      ...(operation.result.url ? { url: operation.result.url } : {}),
    };
  }
  return {
    kind: operation.status,
    operationKey: operation.key,
    reason: operation.failureReason ?? "No failure reason recorded",
  };
}

export const replayMergeOperation = mergeReplayResult;

export type MergeOperationEvent =
  | {
      type: "claim";
      operationKey: string;
      target: MergeTarget;
      stageSha: string;
      issueNumber?: number;
      prNumber?: number;
      actor: string;
      at: string;
    }
  | { type: "start"; actor: string; at: string }
  | { type: "succeed"; actor: string; at: string; mergeSha: string; pullRequestNumber: number; url?: string }
  | { type: "block"; actor: string; at: string; reason: string }
  | { type: "retry"; actor: string; at: string; reason: string };

export type MergeOperationTransition =
  | { kind: "transitioned"; operation: MergeOperation }
  | { kind: "replay"; operation: MergeOperation; replay: MergeReplayResult }
  | { kind: "rejected"; operation?: MergeOperation; reason: string };

export function reduceMergeOperation(
  current: MergeOperation | undefined,
  event: MergeOperationEvent,
): MergeOperationTransition {
  try {
    validateActor(event.actor);
    validateTimestamp(event.at);
    if (current) validateOperation(current);

    if (event.type === "claim") return claimMergeOperation(current, event);
    if (!current) return { kind: "rejected", reason: "Merge operation must be claimed first" };
    if (event.actor !== current.claimant) {
      return { kind: "rejected", operation: current, reason: "Only the current claimant may transition the merge operation" };
    }
    if (Date.parse(event.at) < Date.parse(current.updatedAt)) {
      return { kind: "rejected", operation: current, reason: "Merge operation events must be chronological" };
    }

    switch (event.type) {
      case "start":
        if (current.status !== "claimed") return invalidTransition(current, "running");
        return transitioned(current, "running", event);
      case "succeed": {
        if (current.status !== "running") return invalidTransition(current, "succeeded");
        const result: MergeSuccess = {
          mergeSha: normalizeSha(event.mergeSha),
          pullRequestNumber: positiveInteger(event.pullRequestNumber, "Merged pull request number"),
          ...(event.url ? { url: validateUrl(event.url) } : {}),
        };
        return transitioned(current, "succeeded", event, { result, failureReason: undefined });
      }
      case "block":
        if (current.status !== "claimed" && current.status !== "running") {
          return invalidTransition(current, "blocked");
        }
        return transitioned(current, "blocked", event, { failureReason: boundedDetail(event.reason), result: undefined });
      case "retry":
        if (current.status !== "claimed" && current.status !== "running") {
          return invalidTransition(current, "retryable");
        }
        return transitioned(current, "retryable", event, { failureReason: boundedDetail(event.reason), result: undefined });
    }
  } catch (error) {
    return {
      kind: "rejected",
      ...(current ? { operation: current } : {}),
      reason: error instanceof Error ? error.message : "Invalid merge operation transition",
    };
  }
}

export const transitionMergeOperation = reduceMergeOperation;

function claimMergeOperation(
  current: MergeOperation | undefined,
  event: Extract<MergeOperationEvent, { type: "claim" }>,
): MergeOperationTransition {
  const stageSha = normalizeSha(event.stageSha);
  const issueNumber = event.issueNumber === undefined
    ? undefined
    : positiveInteger(event.issueNumber, "Issue number");
  const prNumber = event.prNumber === undefined
    ? undefined
    : positiveInteger(event.prNumber, "Stage pull request number");
  const expectedKey = mergeOperationKey({ target: event.target, stageSha, prNumber, issueNumber });
  if (event.operationKey !== expectedKey) {
    return { kind: "rejected", ...(current ? { operation: current } : {}), reason: "Merge operation key does not match its inputs" };
  }

  if (!current) {
    const operation: MergeOperation = {
      key: event.operationKey,
      target: event.target,
      stageSha,
      ...(issueNumber === undefined ? {} : { issueNumber }),
      ...(prNumber === undefined ? {} : { prNumber }),
      status: "claimed",
      claimant: event.actor,
      attempt: 1,
      createdAt: event.at,
      updatedAt: event.at,
      audit: [auditEntry("claimed", event)],
    };
    return { kind: "transitioned", operation };
  }

  if (current.key !== event.operationKey) {
    return { kind: "rejected", operation: current, reason: "A different merge operation already occupies this record" };
  }
  if (current.target !== event.target || current.stageSha !== stageSha) {
    return { kind: "rejected", operation: current, reason: "Merge claim does not match the existing operation" };
  }
  if (current.status !== "retryable") {
    return { kind: "replay", operation: current, replay: mergeReplayResult(current) };
  }
  if (Date.parse(event.at) < Date.parse(current.updatedAt)) {
    return { kind: "rejected", operation: current, reason: "Merge operation events must be chronological" };
  }

  const operation: MergeOperation = {
    ...current,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(prNumber === undefined ? {} : { prNumber }),
    status: "claimed",
    claimant: event.actor,
    attempt: current.attempt + 1,
    updatedAt: event.at,
    failureReason: undefined,
    result: undefined,
    audit: appendAudit(current.audit, auditEntry("claimed", event)),
  };
  return { kind: "transitioned", operation };
}

function transitioned(
  current: MergeOperation,
  status: MergeOperationStatus,
  event: Exclude<MergeOperationEvent, { type: "claim" }>,
  changes: Partial<MergeOperation> = {},
): MergeOperationTransition {
  const detail = event.type === "block" || event.type === "retry" ? event.reason : undefined;
  return {
    kind: "transitioned",
    operation: {
      ...current,
      ...changes,
      status,
      updatedAt: event.at,
      audit: appendAudit(current.audit, auditEntry(status, event, detail)),
    },
  };
}

function invalidTransition(current: MergeOperation, next: MergeOperationStatus): MergeOperationTransition {
  return {
    kind: "rejected",
    operation: current,
    reason: `Cannot transition merge operation from ${current.status} to ${next}`,
  };
}

function auditEntry(
  action: MergeOperationStatus,
  event: { at: string; actor: string },
  detail?: string,
): MergeAuditEntry {
  return {
    at: event.at,
    actor: event.actor,
    action,
    ...(detail === undefined ? {} : { detail: boundedDetail(detail) }),
  };
}

function appendAudit(audit: readonly MergeAuditEntry[], entry: MergeAuditEntry) {
  return [...audit, entry].slice(-MAX_MERGE_AUDIT_ENTRIES);
}

function validateOperation(operation: MergeOperation) {
  const expectedKey = mergeOperationKey({
    target: operation.target,
    stageSha: operation.stageSha,
    prNumber: operation.prNumber,
    issueNumber: operation.issueNumber,
  });
  if (operation.key !== expectedKey) throw new Error("Invalid merge operation key");
  validateActor(operation.claimant);
  positiveInteger(operation.attempt, "Merge attempt");
  validateTimestamp(operation.createdAt);
  validateTimestamp(operation.updatedAt);
  if (operation.audit.length < 1 || operation.audit.length > MAX_MERGE_AUDIT_ENTRIES) {
    throw new Error("Invalid merge audit history length");
  }
  for (const entry of operation.audit) {
    validateTimestamp(entry.at);
    validateActor(entry.actor);
    if (entry.detail && entry.detail.length > MAX_MERGE_AUDIT_DETAIL_LENGTH) {
      throw new Error("Merge audit detail is too long");
    }
  }
  if (operation.failureReason !== undefined) {
    if (!operation.failureReason.trim()) throw new Error("Merge failure reason is required");
    if (operation.failureReason.length > MAX_MERGE_AUDIT_DETAIL_LENGTH) {
      throw new Error("Merge failure reason is too long");
    }
  }
  if ((operation.status === "blocked" || operation.status === "retryable") && !operation.failureReason) {
    throw new Error(`${operation.status} merge operation requires a failure reason`);
  }
  if (operation.status === "succeeded") {
    if (!operation.result) throw new Error("Succeeded merge operation requires a result");
    normalizeSha(operation.result.mergeSha);
    positiveInteger(operation.result.pullRequestNumber, "Merged pull request number");
    if (operation.result.url) validateUrl(operation.result.url);
  } else if (operation.result) {
    throw new Error("Only a succeeded merge operation may contain a result");
  }
}

function normalizeTarget(target: string): MergeTarget {
  const normalized = target.trim().toLowerCase();
  if (normalized === "stage") return "stage";
  if (normalized === "prod" || normalized === "production") return "prod";
  throw new Error("Invalid merge target");
}

function parseIssueSelector(selector: string | number) {
  if (typeof selector === "number") return positiveInteger(selector, "Issue selector");
  const normalized = selector.trim();
  if (!/^#?[1-9]\d*$/.test(normalized)) throw new Error("Invalid issue selector");
  return positiveInteger(Number(normalized.replace(/^#/, "")), "Issue selector");
}

function normalizeSha(sha: string) {
  const normalized = sha.trim().toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(normalized)) throw new Error("Invalid Git SHA");
  return normalized;
}

function positiveInteger(value: number | undefined, label: string) {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function validateActor(actor: string) {
  if (!actor.trim() || actor.length > MAX_MERGE_ACTOR_LENGTH) throw new Error("Invalid merge actor");
}

function validateTimestamp(at: string) {
  if (!at || !Number.isFinite(Date.parse(at))) throw new Error("Invalid merge timestamp");
}

function validateUrl(url: string) {
  if (url.length > MAX_MERGE_URL_LENGTH) throw new Error("Merge URL is too long");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Merge URL must use HTTPS");
  return url;
}

function boundedDetail(detail: string) {
  const normalized = detail.trim();
  if (!normalized) throw new Error("Merge audit detail is required");
  return normalized.slice(0, MAX_MERGE_AUDIT_DETAIL_LENGTH);
}
