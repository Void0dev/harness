import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startHealthServer } from "../src/health.js";

const workerContractDirectory = path.resolve(
  import.meta.dirname,
  "../../../skills/deploy-issue-harness-agent/assets/contracts",
);

async function addressFor(options: Parameters<typeof startHealthServer>[0]) {
  const server = await startHealthServer(options);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("liveness reports only that the process is alive", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    workspaceOrigin: "https://github.com/acme/service.git",
    isReady: () => false,
    getWorkerHeartbeatAt: () => null,
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/live`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "alive" });
});

test("readiness is independent from repository identity and worker heartbeat", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    isReady: () => false,
    getWorkerHeartbeatAt: () => Date.now(),
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "not-ready" });
});

test("repository identity has a dedicated response", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    workspaceOrigin: "https://github.com/acme/service.git",
    healthDetailsToken: "health-secret",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
  });
  t.after(() => server.close());

  assert.equal((await fetch(`${baseUrl}/identity`)).status, 401);
  const response = await fetch(`${baseUrl}/identity`, {
    headers: { authorization: "Bearer health-secret" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    repository: "acme/service",
    workspaceOrigin: "https://github.com/acme/service.git",
  });
});

test("worker heartbeat reports stale polling separately from readiness", async (t) => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    isReady: () => true,
    getWorkerHeartbeatAt: () => now - 180_001,
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    workerHeartbeatStaleAfterMs: 180_000,
    now: () => now,
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health/worker`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    status: "stale",
    lastHeartbeatAt: "2026-07-17T09:56:59.999Z",
    ageMs: 180_001,
    activity: { poll: "waiting", run: "idle" },
  });
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
});

test("event-loop heartbeat remains healthy while poll and run states are reported independently", async (t) => {
  const now = Date.parse("2026-07-17T10:00:00.000Z");
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerHeartbeatAt: () => now - 1_000,
    workerHeartbeatStaleAfterMs: 10_000,
    getWorkerActivity: () => ({ poll: "waiting", run: "running" }),
    now: () => now,
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health/worker`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    status: "healthy",
    lastHeartbeatAt: "2026-07-17T09:59:59.000Z",
    ageMs: 1_000,
    activity: { poll: "waiting", run: "running" },
  });
});

test("worker heartbeat has one exact schema even before the first heartbeat", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerHeartbeatAt: () => null,
    getWorkerActivity: () => ({ poll: "polling", run: "idle" }),
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health/worker`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    status: "stale",
    lastHeartbeatAt: null,
    ageMs: null,
    activity: { poll: "polling", run: "idle" },
  });
});

test("worker heartbeat age is always a nonnegative integer for cross-language verification", async (t) => {
  const now = Date.parse("2026-07-20T10:00:01.000Z");
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerHeartbeatAt: () => now - 1_000.75,
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    now: () => now,
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health/worker`);
  const payload = await response.json() as { ageMs: unknown };
  assert.equal(payload.ageMs, 1_000);
  assert.equal(Number.isSafeInteger(payload.ageMs), true);
});

test("exported worker-health v1 fixture and schema match the live wire contract", async (t) => {
  const fixture = await readJsonOrNull(path.join(workerContractDirectory, "worker-health-v1.healthy.json"));
  const schema = await readJsonOrNull(path.join(workerContractDirectory, "worker-health-v1.schema.json"));
  assert.notEqual(fixture, null, "worker health fixture must be packaged with the deploy skill");
  assert.notEqual(schema, null, "worker health schema must be packaged with the deploy skill");

  const now = Date.parse("2026-07-20T10:00:01.000Z");
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerHeartbeatAt: () => now - 1_000,
    getWorkerActivity: () => ({ poll: "waiting", run: "running" }),
    now: () => now,
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health/worker`);
  assert.deepEqual(await response.json(), fixture);
  assert.deepEqual((schema as { required: unknown }).required, [
    "schemaVersion",
    "status",
    "lastHeartbeatAt",
    "ageMs",
    "activity",
  ]);
  assert.deepEqual(
    (schema as { properties: { activity: { properties: { poll: { enum: unknown } } } } })
      .properties.activity.properties.poll.enum,
    ["waiting", "polling"],
  );
  assert.deepEqual(
    (schema as { properties: { activity: { properties: { run: { enum: unknown } } } } })
      .properties.activity.properties.run.enum,
    ["idle", "running"],
  );
});

test("diagnostics require a bearer token and omit repository and workspace data", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "private/secret-repository",
    workspaceOrigin: "https://github.com/private/secret-repository.git",
    isReady: () => true,
    getWorkerHeartbeatAt: () => Date.now(),
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    healthDetailsToken: "diagnostic-secret",
  });
  t.after(() => server.close());

  assert.equal((await fetch(`${baseUrl}/diagnostics`)).status, 401);
  const response = await fetch(`${baseUrl}/diagnostics`, {
    headers: { authorization: "Bearer diagnostic-secret" },
  });
  assert.equal(response.status, 200);
  const body = JSON.stringify(await response.json());
  assert.doesNotMatch(body, /private|secret-repository|github\.com|diagnostic-secret/i);
  assert.match(body, /"access":"token"/);
});

test("diagnostics are disabled when no token is configured", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
  });
  t.after(() => server.close());
  assert.equal((await fetch(`${baseUrl}/diagnostics`)).status, 404);
});

test("legacy combined health and unknown paths are not exposed", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
  });
  t.after(() => server.close());

  assert.equal((await fetch(`${baseUrl}/health`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/other`)).status, 404);
});

async function readJsonOrNull(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
