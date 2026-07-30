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

test("the internal Issue command requires its bearer token and creates through Harness", async (t) => {
  let observed: unknown;
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    commandToken: "command-secret",
    createIssue: async (request) => {
      observed = request;
      return { number: 57, url: "https://github.com/acme/service/issues/57" };
    },
  });
  t.after(() => server.close());

  const unauthorized = await fetch(`${baseUrl}/commands/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Fix login", parentSessionId: "ses_parent_12345678" }),
  });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/commands/issues`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Fix login", parentSessionId: "ses_parent_12345678" }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(observed, {
    title: "Fix login",
    body: "Fix login\n\n<!-- opencode-harness-parent: ses_parent_12345678 -->",
    labels: ["ai:todo"],
  });
  assert.deepEqual(await response.json(), {
    number: 57,
    url: "https://github.com/acme/service/issues/57",
  });
});

test("the internal Issue command rejects creation only for the same parent", async (t) => {
  let creates = 0;
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "running" }),
    commandToken: "command-secret",
    getBlockingIssue: async (parentSessionId) =>
      parentSessionId === "ses_parent_12345678" ? { number: 1 } : null,
    createIssue: async () => {
      creates += 1;
      return { number: 58, url: "https://github.com/acme/service/issues/58" };
    },
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/commands/issues`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Another change", parentSessionId: "ses_parent_12345678" }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "issue-processing-busy", issueNumber: 1 });
  assert.equal(creates, 0);

  const otherParent = await fetch(`${baseUrl}/commands/issues`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Independent task", parentSessionId: "ses_other_12345678" }),
  });
  assert.equal(otherParent.status, 201);
  assert.equal(creates, 1);
});

test("concurrent Issue commands reserve one parent before GitHub creation finishes", async (t) => {
  let creates = 0;
  let releaseCreation!: () => void;
  const creationBlocked = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    commandToken: "command-secret",
    getBlockingIssue: async () => null,
    createIssue: async () => {
      creates += 1;
      if (creates === 1) await creationBlocked;
      return {
        number: 56 + creates,
        url: `https://github.com/acme/service/issues/${56 + creates}`,
      };
    },
  });
  t.after(() => server.close());

  const request = () => fetch(`${baseUrl}/commands/issues`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "One task", parentSessionId: "ses_parent_12345678" }),
  });

  const first = request();
  while (creates === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = await request();
  releaseCreation();
  const firstResponse = await first;

  assert.equal(firstResponse.status, 201);
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "issue-processing-busy" });
  assert.equal(creates, 1);
});

test("the internal answer command queues the first parent reply", async (t) => {
  let observed: unknown;
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    commandToken: "command-secret",
    submitHumanAnswer: async (request) => {
      observed = request;
      return { issueNumber: 57 };
    },
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/commands/answers`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Use PostgreSQL", parentSessionId: "ses_parent_12345678" }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { issueNumber: 57 });
  assert.deepEqual(observed, { text: "Use PostgreSQL", parentSessionId: "ses_parent_12345678" });
});

test("the internal answer command returns no-content when the parent is not waiting", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    commandToken: "command-secret",
    submitHumanAnswer: async () => null,
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/commands/answers`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Normal chat", parentSessionId: "ses_parent_12345678" }),
  });
  assert.equal(response.status, 204);
});

test("the internal retry command queues only an explicit recoverable retry", async (t) => {
  let observed: unknown;
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    commandToken: "command-secret",
    submitRetry: async (request) => {
      observed = request;
      return { issueNumber: 57 };
    },
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/commands/retries`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      parentSessionId: "ses_parent_12345678",
      instruction: "Исправь также адаптивную вёрстку",
    }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { issueNumber: 57 });
  assert.deepEqual(observed, {
    parentSessionId: "ses_parent_12345678",
    instruction: "Исправь также адаптивную вёрстку",
  });
});

test("the internal retry command rejects an oversized correction", async (t) => {
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    commandToken: "command-secret",
    submitRetry: async () => ({ issueNumber: 57 }),
  });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/commands/retries`, {
    method: "POST",
    headers: {
      authorization: "Bearer command-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      parentSessionId: "ses_parent_12345678",
      instruction: "x".repeat(16_001),
    }),
  });

  assert.equal(response.status, 400);
});

test("the task-card endpoint returns only the authenticated parent projection", async (t) => {
  let observedParent = "";
  const { server, baseUrl } = await addressFor({
    port: 0,
    repository: "acme/service",
    getWorkerActivity: () => ({ poll: "waiting", run: "idle" }),
    commandToken: "command-secret",
    getTaskViews: async (parentSessionId) => {
      observedParent = parentSessionId;
      return [{
        schemaVersion: 1,
        issueNumber: 57,
        title: "Fix login",
        status: "running",
        stages: ["accepted", "studying"],
        updatedAt: "2026-07-28T10:00:00.000Z",
      }];
    },
  });
  t.after(() => server.close());

  const path = "/ui/tasks?parentSessionId=ses_parent_12345678";
  assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: "Bearer command-secret" },
  });
  assert.equal(response.status, 200);
  assert.equal(observedParent, "ses_parent_12345678");
  assert.deepEqual(await response.json(), { tasks: [{
    schemaVersion: 1,
    issueNumber: 57,
    title: "Fix login",
    status: "running",
    stages: ["accepted", "studying"],
    updatedAt: "2026-07-28T10:00:00.000Z",
  }] });
});

async function readJsonOrNull(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
