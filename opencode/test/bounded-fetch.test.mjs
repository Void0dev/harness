import assert from "node:assert/strict";
import test from "node:test";
import { fetchBounded } from "../lib/bounded-fetch.mjs";

test("bounds a response body that never finishes", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
  }), { status: 200, headers: { "content-type": "application/json" } });

  await assert.rejects(fetchBounded({
    url: "http://harness.local/ui/tasks",
    fetchImpl: async () => response,
    timeoutMs: 10,
  }), /timed out/i);
});

test("rejects an oversized upstream body before proxying it", async () => {
  await assert.rejects(fetchBounded({
    url: "http://harness.local/ui/tasks",
    fetchImpl: async () => new Response("x".repeat(33), { status: 200 }),
    maximumBytes: 32,
  }), /too large/i);
});

test("returns a bounded upstream response unchanged", async () => {
  const result = await fetchBounded({
    url: "http://harness.local/ui/tasks",
    headers: { Authorization: "Bearer secret" },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer secret");
      return Response.json({ tasks: [] }, { status: 200 });
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.contentType, "application/json");
  assert.equal(result.body.toString("utf8"), '{"tasks":[]}');
});
