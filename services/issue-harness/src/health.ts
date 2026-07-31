import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildIssueRequest } from "./issue-command.js";
import { sanitizeTaskView, type TaskView } from "./task-view.js";

type HealthServerOptions = {
  port: number;
  repository: string;
  workspaceOrigin?: string;
  isReady?: () => boolean;
  getWorkerHeartbeatAt?: () => number | null;
  getWorkerActivity: () => WorkerActivity;
  workerHeartbeatStaleAfterMs?: number;
  healthDetailsToken?: string;
  now?: () => number;
  commandToken?: string;
  getBlockingIssue?: (parentSessionId: string) => Promise<{ number: number } | null>;
  createIssue?: (request: ReturnType<typeof buildIssueRequest>) => Promise<{ number: number; url: string }>;
  submitHumanAnswer?: (request: { text: string; parentSessionId: string }) => Promise<{ issueNumber: number } | null>;
  submitRetry?: (request: { parentSessionId: string; instruction?: string }) => Promise<{ issueNumber: number } | null>;
  getTaskViews?: (parentSessionId: string) => Promise<TaskView[]>;
};

export const WORKER_HEALTH_SCHEMA_VERSION = 1 as const;
export const WORKER_POLL_STATES = ["waiting", "polling"] as const;
export const WORKER_RUN_STATES = ["idle", "running"] as const;

export type WorkerActivity = {
  poll: typeof WORKER_POLL_STATES[number];
  run: typeof WORKER_RUN_STATES[number];
};

type WorkerHeartbeat = {
  schemaVersion: typeof WORKER_HEALTH_SCHEMA_VERSION;
  status: "healthy" | "stale";
  lastHeartbeatAt: string | null;
  ageMs: number | null;
  activity: WorkerActivity;
};

function json(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function workerHeartbeat(options: HealthServerOptions): WorkerHeartbeat {
  const activity = options.getWorkerActivity();
  const lastHeartbeatAt = options.getWorkerHeartbeatAt?.() ?? null;
  if (lastHeartbeatAt === null || !Number.isFinite(lastHeartbeatAt)) {
    return {
      schemaVersion: WORKER_HEALTH_SCHEMA_VERSION,
      status: "stale",
      lastHeartbeatAt: null,
      ageMs: null,
      activity,
    };
  }
  const ageMs = Math.max(0, Math.floor((options.now?.() ?? Date.now()) - lastHeartbeatAt));
  const staleAfterMs = options.workerHeartbeatStaleAfterMs ?? 180_000;
  return {
    schemaVersion: WORKER_HEALTH_SCHEMA_VERSION,
    status: ageMs <= staleAfterMs ? "healthy" : "stale",
    lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(),
    ageMs,
    activity,
  };
}

export async function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const pendingIssueParents = new Set<string>();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://harness.local");
    if (request.method === "POST" && request.url === "/commands/issues") {
      void handleIssueCommand(request, response, options, pendingIssueParents);
      return;
    }
    if (request.method === "POST" && request.url === "/commands/answers") {
      void handleAnswerCommand(request, response, options);
      return;
    }
    if (request.method === "POST" && request.url === "/commands/retries") {
      void handleRetryCommand(request, response, options);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/ui/tasks") {
      void handleTaskViews(request, response, options, requestUrl);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }

    if (request.url === "/live") {
      json(response, 200, { status: "alive" });
      return;
    }

    if (request.url === "/ready") {
      const ready = options.isReady?.() ?? true;
      json(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready" });
      return;
    }

    if (request.url === "/health/worker") {
      const heartbeat = workerHeartbeat(options);
      json(response, heartbeat.status === "healthy" ? 200 : 503, heartbeat);
      return;
    }

    if (request.url === "/identity") {
      if (!options.healthDetailsToken) {
        response.writeHead(404).end();
        return;
      }
      if (!bearerTokenMatches(request.headers.authorization, options.healthDetailsToken)) {
        response.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      json(response, 200, {
        repository: options.repository,
        ...(options.workspaceOrigin ? { workspaceOrigin: options.workspaceOrigin } : {}),
      });
      return;
    }

    if (request.url === "/diagnostics") {
      if (!options.healthDetailsToken) {
        response.writeHead(404).end();
        return;
      }
      if (!bearerTokenMatches(request.headers.authorization, options.healthDetailsToken)) {
        response.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      const heartbeat = workerHeartbeat(options);
      json(response, 200, {
        status: "ok",
        access: "token",
        ready: options.isReady?.() ?? true,
        workerHeartbeat: heartbeat.status,
        activity: heartbeat.activity,
      });
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleTaskViews(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
  requestUrl: URL,
) {
  if (!options.commandToken || !options.getTaskViews) {
    response.writeHead(404).end();
    return;
  }
  if (!bearerTokenMatches(request.headers.authorization, options.commandToken)) {
    response.writeHead(401, { "www-authenticate": "Bearer" }).end();
    return;
  }
  const parentSessionId = requestUrl.searchParams.get("parentSessionId") ?? "";
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)) {
    json(response, 400, { error: "invalid-parent-session" });
    return;
  }
  try {
    const tasks = (await options.getTaskViews(parentSessionId)).map(sanitizeTaskView);
    json(response, 200, { tasks });
  } catch {
    json(response, 503, { error: "task-view-unavailable" });
  }
}

async function handleAnswerCommand(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
) {
  if (!options.commandToken || !options.submitHumanAnswer) {
    response.writeHead(404).end();
    return;
  }
  if (!bearerTokenMatches(request.headers.authorization, options.commandToken)) {
    response.writeHead(401, { "www-authenticate": "Bearer" }).end();
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedBody(request, 64 * 1024));
  } catch {
    json(response, 400, { error: "invalid-request" });
    return;
  }
  const input = payload as { text?: unknown; parentSessionId?: unknown };
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  const parentSessionId = typeof input?.parentSessionId === "string" ? input.parentSessionId : "";
  if (
    !text
    || text.length > 16_000
    || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)
  ) {
    json(response, 400, { error: "invalid-request" });
    return;
  }
  try {
    const result = await options.submitHumanAnswer({ text, parentSessionId });
    if (!result) {
      response.writeHead(204).end();
      return;
    }
    json(response, 202, result);
  } catch {
    json(response, 503, { error: "answer-queue-failed" });
  }
}

async function handleRetryCommand(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
) {
  if (!options.commandToken || !options.submitRetry) {
    response.writeHead(404).end();
    return;
  }
  if (!bearerTokenMatches(request.headers.authorization, options.commandToken)) {
    response.writeHead(401, { "www-authenticate": "Bearer" }).end();
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedBody(request, 64 * 1024));
  } catch {
    json(response, 400, { error: "invalid-request" });
    return;
  }
  const input = payload as { parentSessionId?: unknown; instruction?: unknown };
  const parentSessionId = typeof input?.parentSessionId === "string"
    ? input.parentSessionId
    : "";
  const instruction = typeof input?.instruction === "string" ? input.instruction.trim() : "";
  if (
    !/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)
    || instruction.length > 16_000
    || (input?.instruction !== undefined && typeof input.instruction !== "string")
  ) {
    json(response, 400, { error: "invalid-request" });
    return;
  }
  try {
    const result = await options.submitRetry({
      parentSessionId,
      ...(instruction ? { instruction } : {}),
    });
    if (!result) {
      response.writeHead(204).end();
      return;
    }
    json(response, 202, result);
  } catch {
    json(response, 503, { error: "retry-queue-failed" });
  }
}

async function handleIssueCommand(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
  pendingIssueParents: Set<string>,
) {
  if (!options.commandToken || !options.createIssue) {
    response.writeHead(404).end();
    return;
  }
  if (!bearerTokenMatches(request.headers.authorization, options.commandToken)) {
    response.writeHead(401, { "www-authenticate": "Bearer" }).end();
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedBody(request, 64 * 1024));
  } catch (error) {
    const tooLarge = (error as Error).message === "request body too large";
    json(response, tooLarge ? 413 : 400, { error: tooLarge ? "request-too-large" : "invalid-request" });
    return;
  }

  if (!payload || typeof payload !== "object") {
    json(response, 400, { error: "invalid-request" });
    return;
  }
  const input = payload as { text?: unknown; parentSessionId?: unknown };
  let issueRequest: ReturnType<typeof buildIssueRequest>;
  try {
    issueRequest = buildIssueRequest({
      text: typeof input.text === "string" ? input.text : "",
      parentSessionId: typeof input.parentSessionId === "string" ? input.parentSessionId : "",
    });
  } catch {
    json(response, 400, { error: "invalid-request" });
    return;
  }

  const parentSessionId = input.parentSessionId as string;
  if (pendingIssueParents.has(parentSessionId)) {
    json(response, 409, { error: "issue-processing-busy" });
    return;
  }
  pendingIssueParents.add(parentSessionId);
  let checkingQueue = true;
  try {
    if (options.getBlockingIssue) {
      const blockingIssue = await options.getBlockingIssue(parentSessionId);
      if (blockingIssue) {
        json(response, 409, {
          error: "issue-processing-busy",
          issueNumber: blockingIssue.number,
        });
        return;
      }
    }
    checkingQueue = false;
    json(response, 201, await options.createIssue(issueRequest));
  } catch (error) {
    const details = error instanceof Error
      ? { name: error.name, message: error.message, status: (error as { status?: unknown }).status }
      : { message: String(error) };
    console.error("Issue command failed", { stage: checkingQueue ? "queue-check" : "github-create", ...details });
    json(response, checkingQueue ? 503 : 502, {
      error: checkingQueue ? "issue-queue-check-failed" : "github-issue-creation-failed",
    });
  } finally {
    pendingIssueParents.delete(parentSessionId);
  }
}

async function readBoundedBody(request: IncomingMessage, maximumBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
