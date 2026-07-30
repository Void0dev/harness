import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PublicationArtifactReference } from "./artifact.js";
import { ensurePrivateRuntimeDirectory, fsyncDirectory } from "./security.js";
import { sanitizeTaskView, type TaskView } from "./task-view.js";

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
  taskView?: TaskView;
  publicationArtifact?: PublicationArtifactReference;
  stalePublicationArtifacts?: StalePublicationArtifact[];
  publishedCommitSha?: string;
  prUrl?: string;
  updatedAt: string;
};

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
    prUrl: _prUrl,
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
  private writeChain = Promise.resolve();

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
        : isStateEnvelope(parsed)
          ? parsed.runs
          : undefined;
      if (!runs) throw new Error("runs.json must be a legacy array or schemaVersion 2 envelope");
      const validated = runs.map(validateRunState);
      this.states = new Map(validated.map((item) => [item.issueNumber, item]));
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

  async set(state: Omit<IssueRunState, "updatedAt">) {
    const next = validateRunState({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    this.states.set(next.issueNumber, next);
    const snapshot = [...this.states.values()].sort((left, right) => left.issueNumber - right.issueNumber);
    const write = this.writeChain.then(() => this.flush(snapshot));
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private async flush(runs: IssueRunState[]) {
    const payload = JSON.stringify({ schemaVersion: 2, runs }, null, 2);
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

function isStateEnvelope(value: unknown): value is { schemaVersion: 2; runs: unknown[] } {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { schemaVersion?: unknown }).schemaVersion === 2
    && Array.isArray((value as { runs?: unknown }).runs),
  );
}

function validateRunState(value: unknown): IssueRunState {
  if (!value || typeof value !== "object") throw new Error("Invalid issue run state");
  const state = value as Partial<IssueRunState>;
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
  if (
    state.awaitingAction !== undefined
    && !new Set(["resume_child", "retry_publish", "rerun"]).has(state.awaitingAction)
  ) throw new Error("Invalid awaiting action");
  if (state.pendingHumanReply !== undefined && (
    typeof state.pendingHumanReply !== "string"
    || state.pendingHumanReply.trim().length === 0
    || state.pendingHumanReply.length > 16_000
  )) throw new Error("Invalid pending human reply");
  if (state.taskView !== undefined) state.taskView = sanitizeTaskView(state.taskView);
  return state as IssueRunState;
}
