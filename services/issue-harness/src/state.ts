import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateRuntimeDirectory, fsyncDirectory } from "./security.js";
import { sanitizeTaskView, type TaskView } from "./task-view.js";

export type IssueRunState = {
  issueNumber: number;
  branch: string;
  status: "running" | "awaiting_human" | "finished" | "failed";
  parentSessionId?: string;
  lastSessionId?: string;
  lastLogPath?: string;
  workspace?: string;
  baseSha?: string;
  awaitingAction?: "resume_child" | "rerun";
  pendingHumanReply?: string;
  humanQuestionCommentId?: number;
  humanLatestCommentId?: number;
  humanCommentResumeAfter?: string;
  taskView?: TaskView;
  prNumber?: number;
  prUrl?: string;
  prHeadSha?: string;
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
  return "run" as const;
}

export function activeRunForParent(states: IssueRunState[], parentSessionId: string) {
  validateParentSessionId(parentSessionId);
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
      const runs = Array.isArray(parsed) ? parsed : stateEnvelopeRuns(parsed);
      if (!runs) throw new Error("runs.json must be a legacy array or supported state envelope");
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
    const next = validateRunState({ ...state, updatedAt: new Date().toISOString() });
    this.states.set(next.issueNumber, next);
    await this.persist();
  }

  private async persist() {
    const write = this.writeChain.then(() => this.flush());
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private async flush() {
    const runs = [...this.states.values()].sort((left, right) => left.issueNumber - right.issueNumber);
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

function stateEnvelopeRuns(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const envelope = value as { schemaVersion?: unknown; runs?: unknown };
  return new Set([2, 3]).has(Number(envelope.schemaVersion)) && Array.isArray(envelope.runs)
    ? envelope.runs
    : undefined;
}

function validateRunState(value: unknown): IssueRunState {
  if (!value || typeof value !== "object") throw new Error("Invalid issue run state");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => /token|password|secret|private.?key|credential/i.test(key))) {
    throw new Error("Issue run state must not contain credentials");
  }
  const legacyPublishPending = source.status === "publish_pending";
  const legacyPublication = legacyPublishPending || source.awaitingAction === "retry_publish";
  const status = legacyPublishPending ? "awaiting_human" : source.status;
  if (
    !Number.isSafeInteger(source.issueNumber)
    || Number(source.issueNumber) <= 0
    || typeof source.branch !== "string"
    || source.branch.length === 0
    || !new Set(["running", "awaiting_human", "finished", "failed"]).has(String(status))
    || typeof source.updatedAt !== "string"
    || Number.isNaN(Date.parse(source.updatedAt))
  ) throw new Error("Invalid issue run state fields");

  for (const sessionId of [source.parentSessionId, source.lastSessionId]) {
    if (sessionId !== undefined && (typeof sessionId !== "string" || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(sessionId))) {
      throw new Error("Invalid OpenCode session ID");
    }
  }
  if (source.workspace !== undefined && (
    typeof source.workspace !== "string"
    || !path.isAbsolute(source.workspace)
    || source.workspace.length > 4_096
  )) throw new Error("Invalid OpenCode workspace path");
  if (source.baseSha !== undefined && (
    typeof source.baseSha !== "string"
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.baseSha)
  )) throw new Error("Invalid base SHA");
  if (source.prNumber !== undefined && (!Number.isSafeInteger(source.prNumber) || Number(source.prNumber) <= 0)) {
    throw new Error("Invalid pull request number");
  }
  if (source.prUrl !== undefined) validateCredentialFreeHttpsUrl(source.prUrl, "Pull request URL");
  if (source.prHeadSha !== undefined && (
    typeof source.prHeadSha !== "string"
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.prHeadSha)
  )) throw new Error("Invalid pull request head SHA");

  let awaitingAction = source.awaitingAction;
  if (legacyPublication) {
    awaitingAction = "rerun";
  }
  if (awaitingAction !== undefined && !new Set(["resume_child", "rerun"]).has(String(awaitingAction))) {
    throw new Error("Invalid awaiting action");
  }
  if (source.pendingHumanReply !== undefined && (
    typeof source.pendingHumanReply !== "string"
    || source.pendingHumanReply.trim().length === 0
    || source.pendingHumanReply.length > 16_000
  )) throw new Error("Invalid pending human reply");
  if (source.humanQuestionCommentId !== undefined && (
    !Number.isSafeInteger(source.humanQuestionCommentId)
    || Number(source.humanQuestionCommentId) <= 0
  )) throw new Error("Invalid human question comment ID");
  if (source.humanLatestCommentId !== undefined && (
    source.humanQuestionCommentId === undefined
    || !Number.isSafeInteger(source.humanLatestCommentId)
    || Number(source.humanLatestCommentId) <= Number(source.humanQuestionCommentId)
  )) throw new Error("Invalid latest human comment ID");
  if (source.humanCommentResumeAfter !== undefined && (
    source.humanLatestCommentId === undefined
    || typeof source.humanCommentResumeAfter !== "string"
    || Number.isNaN(Date.parse(source.humanCommentResumeAfter))
  )) throw new Error("Invalid human comment resume time");
  const taskView = source.taskView === undefined ? undefined : sanitizeTaskView(source.taskView);
  const normalizedTaskView = legacyPublication && taskView ? sanitizeTaskView({
    ...taskView,
    status: "failed",
    question: "Предыдущая публикация Harness была прервана. Отправьте /retry, чтобы агент завершил публикацию через GitHub.",
    workerSessionPath: undefined,
  }) : taskView;
  const branch = legacyPublication
    ? freshAgentBranch(source.branch, source.updatedAt)
    : source.branch;

  return {
    issueNumber: Number(source.issueNumber),
    branch,
    status: status as IssueRunState["status"],
    ...optionalString("parentSessionId", source.parentSessionId),
    ...(legacyPublication ? {} : optionalString("lastSessionId", source.lastSessionId)),
    ...(legacyPublication ? {} : optionalString("lastLogPath", source.lastLogPath)),
    ...(legacyPublication ? {} : optionalString("workspace", source.workspace)),
    ...(legacyPublication ? {} : optionalString("baseSha", source.baseSha)),
    ...(awaitingAction === undefined ? {} : { awaitingAction: awaitingAction as IssueRunState["awaitingAction"] }),
    ...(legacyPublication ? {} : optionalString("pendingHumanReply", source.pendingHumanReply)),
    ...(legacyPublication ? {} : optionalNumber("humanQuestionCommentId", source.humanQuestionCommentId)),
    ...(legacyPublication ? {} : optionalNumber("humanLatestCommentId", source.humanLatestCommentId)),
    ...(legacyPublication ? {} : optionalString("humanCommentResumeAfter", source.humanCommentResumeAfter)),
    ...(normalizedTaskView === undefined ? {} : { taskView: normalizedTaskView }),
    ...optionalNumber("prNumber", source.prNumber),
    ...optionalString("prUrl", source.prUrl),
    ...optionalString("prHeadSha", source.prHeadSha),
    updatedAt: new Date(source.updatedAt).toISOString(),
  };
}

function freshAgentBranch(branch: string, updatedAt: unknown) {
  const suffix = `-agent-${Date.parse(String(updatedAt)).toString(36)}`;
  const prefix = branch.slice(0, 240 - suffix.length).replace(/[./]+$/, "");
  if (!prefix) throw new Error("Cannot derive a fresh agent branch");
  return `${prefix}${suffix}`;
}

function optionalString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string") throw new Error(`Invalid ${key}`);
  return { [key]: value } as { [P in K]: string };
}

function optionalNumber<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${key}`);
  return { [key]: Number(value) } as { [P in K]: number };
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
