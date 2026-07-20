import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

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
  const server = createServer((request, response) => {
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
