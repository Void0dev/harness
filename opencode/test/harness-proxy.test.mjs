import assert from "node:assert/strict";
import test from "node:test";
import { forwardHarnessProxy } from "../lib/harness-proxy.mjs";

test("keeps the real Harness token inside the web proxy", async () => {
  let observed;
  const result = await forwardHarnessProxy({
    targetUrl: "http://issue-harness:3000/commands/issues",
    commandToken: "server-only-secret",
    body: Buffer.from('{"text":"test"}'),
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return Response.json({ number: 57 }, { status: 201 });
    },
  });

  assert.equal(observed.url, "http://issue-harness:3000/commands/issues");
  assert.equal(observed.init.headers.Authorization, "Bearer server-only-secret");
  assert.equal(result.status, 201);
  assert.deepEqual(JSON.parse(result.body.toString("utf8")), { number: 57 });
});

test("bounds a stalled Harness upstream request", async () => {
  await assert.rejects(forwardHarnessProxy({
    targetUrl: "http://issue-harness:3000/commands/issues",
    commandToken: "server-only-secret",
    body: Buffer.from("{}"),
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  }), /timed out/i);
});

test("rejects an oversized Harness upstream response", async () => {
  await assert.rejects(forwardHarnessProxy({
    targetUrl: "http://issue-harness:3000/commands/issues",
    commandToken: "server-only-secret",
    body: Buffer.from("{}"),
    maximumResponseBytes: 32,
    fetchImpl: async () => new Response("x".repeat(33), { status: 502 }),
  }), /too large/i);
});
