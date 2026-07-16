import assert from "node:assert/strict";
import test from "node:test";
import { startHealthServer } from "../src/health.js";

test("serves liveness and repository identity", async (t) => {
  const server = await startHealthServer({
    port: 0,
    repository: "acme/service",
    workspaceOrigin: "https://github.com/acme/service.git",
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    repository: "acme/service",
    workspaceOrigin: "https://github.com/acme/service.git",
  });
});

test("returns 404 for non-health paths", async (t) => {
  const server = await startHealthServer({ port: 0, repository: "acme/service" });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/other`);
  assert.equal(response.status, 404);
});

test("reports not ready when the polling loop is stale", async (t) => {
  const server = await startHealthServer({
    port: 0,
    repository: "acme/service",
    workspaceOrigin: "https://github.com/acme/service.git",
    isReady: () => false,
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "degraded");
});
