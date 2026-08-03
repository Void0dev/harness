import path from "node:path";

export const taskStages = ["accepted", "studying", "coding", "testing", "publishing"] as const;
export type TaskStage = typeof taskStages[number];
export type TaskStatus = "queued" | "running" | "awaiting_human" | "publishing" | "finished" | "failed";

export type TaskFileView = {
  path: string;
  additions?: number;
  deletions?: number;
};

export type TaskView = {
  schemaVersion: 1;
  issueNumber: number;
  title: string;
  issueUrl?: string;
  status: TaskStatus;
  stages: TaskStage[];
  question?: string;
  summary?: string;
  files?: TaskFileView[];
  workerSessionPath?: string;
  prUrl?: string;
  modelId?: string;
  generationStartedAt?: string;
  generationCompletedAt?: string;
  updatedAt: string;
};

type StateWithTaskView = {
  issueNumber: number;
  parentSessionId?: string;
  taskView?: TaskView;
};

export function workerSessionDirectory(run: { workspace?: string }, parentDirectory: string) {
  return typeof run.workspace === "string" && run.workspace ? run.workspace : parentDirectory;
}

export function acceptsHumanAnswer(run: { status?: unknown; taskView?: TaskView }) {
  return run.status === "awaiting_human"
    && run.taskView?.status === "awaiting_human"
    && typeof run.taskView.question === "string"
    && Boolean(run.taskView.question.trim());
}

export function acceptsTechnicalRetry(run: {
  status?: unknown;
  awaitingAction?: unknown;
  taskView?: TaskView;
}) {
  return run.status === "awaiting_human"
    && run.taskView?.status === "failed"
    && new Set(["resume_child", "rerun"]).has(String(run.awaitingAction));
}

export function technicalRetryTransition<T extends {
  status?: unknown;
  awaitingAction?: "resume_child" | "rerun";
  lastSessionId?: string;
  workspace?: string;
  baseSha?: string;
}>(run: T, instruction: string) {
  const correction = instruction.trim();
  if (!correction) {
    return {
      ...run,
      status: "running" as const,
      pendingHumanReply: "Retry the interrupted operation after the reported technical failure.",
    };
  }
  const canResumeChild = Boolean(run.lastSessionId && run.workspace && run.baseSha);
  return {
    ...run,
    status: "running" as const,
    awaitingAction: canResumeChild ? "resume_child" as const : "rerun" as const,
    pendingHumanReply: correction,
  };
}

export function sanitizeTaskView(value: unknown): TaskView {
  if (!value || typeof value !== "object") throw new Error("Invalid task view");
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || !Number.isSafeInteger(source.issueNumber) || Number(source.issueNumber) <= 0) {
    throw new Error("Invalid task view identity");
  }
  const title = boundedText(source.title, 240, "title");
  const statuses = new Set<TaskStatus>(["queued", "running", "awaiting_human", "publishing", "finished", "failed"]);
  if (typeof source.status !== "string" || !statuses.has(source.status as TaskStatus)) {
    throw new Error("Invalid task view status");
  }
  if (!Array.isArray(source.stages) || source.stages.length > taskStages.length) {
    throw new Error("Invalid task view stages");
  }
  const stages = source.stages.map((stage) => {
    if (typeof stage !== "string" || !taskStages.includes(stage as TaskStage)) {
      throw new Error("Invalid task view stage");
    }
    return stage as TaskStage;
  });
  if (new Set(stages).size !== stages.length || !isCanonicalStageOrder(stages)) {
    throw new Error("Invalid task view stage order");
  }
  const generation = generationMetadata(source);
  const updatedAt = isoTimestamp(source.updatedAt, "update");
  const files = sanitizeFiles(source.files);
  return {
    schemaVersion: 1,
    issueNumber: Number(source.issueNumber),
    title,
    ...(source.issueUrl === undefined ? {} : { issueUrl: safeHttpUrl(source.issueUrl, "Issue URL") }),
    status: source.status as TaskStatus,
    stages,
    ...(source.question === undefined ? {} : { question: boundedText(source.question, 4_000, "question") }),
    ...(source.summary === undefined ? {} : { summary: boundedText(source.summary, 4_000, "summary") }),
    ...(files === undefined ? {} : { files }),
    ...(source.workerSessionPath === undefined ? {} : {
      workerSessionPath: safeSessionPath(source.workerSessionPath),
    }),
    ...(source.prUrl === undefined ? {} : { prUrl: safeHttpUrl(source.prUrl, "Pull Request URL") }),
    ...generation,
    updatedAt,
  };
}

function generationMetadata(source: Record<string, unknown>) {
  const values = [source.modelId, source.generationStartedAt, source.generationCompletedAt];
  if (values.every((value) => value === undefined)) return {};
  if (typeof source.modelId !== "string" || !source.modelId.trim() || source.modelId.length > 128) {
    throw new Error("Invalid task view model ID");
  }
  const generationStartedAt = isoTimestamp(source.generationStartedAt, "generation start");
  const generationCompletedAt = isoTimestamp(source.generationCompletedAt, "generation completion");
  if (Date.parse(generationCompletedAt) < Date.parse(generationStartedAt)) {
    throw new Error("Invalid task view generation duration");
  }
  return { modelId: source.modelId.trim(), generationStartedAt, generationCompletedAt };
}

function isoTimestamp(value: unknown, field: string) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid task view ${field} time`);
  }
  return new Date(value).toISOString();
}

export function taskViewsForParent(states: StateWithTaskView[], parentSessionId: string) {
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)) {
    throw new Error("Invalid OpenCode parent session ID");
  }
  return states
    .filter((state) => state.parentSessionId === parentSessionId && state.taskView)
    .sort((left, right) => left.issueNumber - right.issueNumber)
    .map((state) => sanitizeTaskView(state.taskView));
}

function boundedText(value: unknown, maximum: number, field: string) {
  if (typeof value !== "string") throw new Error(`Invalid task view ${field}`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`Invalid task view ${field}`);
  }
  return text;
}

function sanitizeFiles(value: unknown): TaskFileView[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500) throw new Error("Invalid task view files");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid task view file");
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || !safeRelativePath(file.path)) {
      throw new Error("Invalid task view file path");
    }
    return {
      path: file.path,
      ...optionalCount(file.additions, "additions"),
      ...optionalCount(file.deletions, "deletions"),
    };
  });
}

function optionalCount(value: unknown, name: "additions" | "deletions") {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000_000) {
    throw new Error(`Invalid task view file ${name}`);
  }
  return { [name]: Number(value) };
}

function safeRelativePath(value: string) {
  const segments = value.split("/");
  return value.length <= 1_024
    && !path.posix.isAbsolute(value)
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    && segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function safeHttpUrl(value: unknown, field: string) {
  if (typeof value !== "string" || value.length > 2_048) throw new Error(`Invalid ${field}`);
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error(`Invalid ${field}`);
  }
  return url.toString();
}

function safeSessionPath(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048 || !/^\/[A-Za-z0-9_\-/]+$/.test(value)) {
    throw new Error("Invalid worker session path");
  }
  return value;
}

function isCanonicalStageOrder(stages: TaskStage[]) {
  let last = -1;
  for (const stage of stages) {
    const next = taskStages.indexOf(stage);
    if (next <= last) return false;
    last = next;
  }
  return true;
}
