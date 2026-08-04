import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeClient } from "../src/opencode-client.js";

test("creates a child session, submits asynchronously, and reads the result after idle", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const progressParts: unknown[] = [];
  let statusReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/home/opencode/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/session" && init?.method === "POST") {
        return Response.json({ id: "ses_child_12345678", parentID: "ses_parent_12345678" });
      }
      if (parsed.pathname === "/session/ses_child_12345678/prompt_async") {
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname === "/session/status") {
        statusReads += 1;
        return Response.json({
          ...(statusReads === 1 ? {} : {
            ses_child_12345678: { type: statusReads === 2 ? "busy" : "idle" },
          }),
        });
      }
      if (parsed.pathname === "/session/ses_child_12345678/message") {
        const final = statusReads >= 3;
        return Response.json(statusReads >= 2 ? [{
          info: { id: "msg_user_1", role: "user", time: { created: 900 } },
          parts: [{ type: "text", text: "Implement the issue" }],
        }, {
          info: {
            id: "msg_1", role: "assistant", parentID: "msg_user_1", modelID: "gpt-5.5",
            time: { created: 1_000, completed: final ? 102_000 : undefined },
          },
          parts: final
            ? [{ type: "text", text: "Done <promise>COMPLETE</promise>" }]
            : [{ type: "tool", tool: "edit", state: { input: { filePath: "src/login.ts" } } }],
        }] : []);
      }
      throw new Error(`Unexpected request: ${init?.method} ${parsed.pathname}`);
    },
  });

  const result = await client.runChild({
    parentSessionId: "ses_parent_12345678",
    directory: "/opt/issue-harness/local-test/runs/issue-7/run-abc",
    title: "Issue #7: fix login",
    prompt: "Implement the issue",
    onProgress: async (parts) => { progressParts.push(parts); },
  });

  assert.equal(result.sessionId, "ses_child_12345678");
  assert.equal(result.text, "Done <promise>COMPLETE</promise>");
  assert.equal(result.modelId, "gpt-5.5");
  assert.equal(result.generationStartedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(result.generationCompletedAt, "1970-01-01T00:01:42.000Z");
  assert.match(requests[0].url, /\/session\?directory=/);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    parentID: "ses_parent_12345678",
    title: "Issue #7: fix login",
  });
  const prompt = requests.find((request) => new URL(request.url).pathname.endsWith("/prompt_async"));
  assert.equal(JSON.parse(String(prompt?.init.body)).agent, "build");
  assert.equal(prompt?.init.method, "POST");
  assert.match(String((requests[0].init.headers as Record<string, string>).Authorization), /^Bearer /);
  assert.ok(progressParts.some((parts) => JSON.stringify(parts).includes("src/login.ts")));
});

test("continues the same child session with a human answer", async () => {
  const requests: string[] = [];
  let messageReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/home/opencode/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      requests.push(`${init?.method} ${parsed.pathname}`);
      if (parsed.pathname.endsWith("/message")) {
        messageReads += 1;
        return Response.json(messageReads === 1 ? [{
          info: { id: "msg_old", role: "assistant" },
          parts: [{ type: "text", text: "Need an answer" }],
        }] : [{
          info: { id: "msg_old", role: "assistant" },
          parts: [{ type: "text", text: "Need an answer" }],
        }, {
          info: { id: "msg_user_new", role: "user" },
          parts: [{ type: "text", text: "Use PostgreSQL" }],
        }, {
          info: { id: "msg_new", role: "assistant", parentID: "msg_user_new", time: { completed: 2_000 } },
          parts: [{ type: "text", text: "Continued <promise>COMPLETE</promise>" }],
        }]);
      }
      if (parsed.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (parsed.pathname === "/session/status") return Response.json({ ses_child_12345678: { type: "idle" } });
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    },
  });

  const result = await client.continueSession({
    sessionId: "ses_child_12345678",
    directory: "/runs/issue-7/run-abc",
    prompt: "Use PostgreSQL",
  });

  assert.equal(result.text, "Continued <promise>COMPLETE</promise>");
  assert.ok(requests.includes("POST /session/ses_child_12345678/prompt_async"));
});

test("does not publish identical streaming progress on every poll", async () => {
  let messageReads = 0;
  let statusReads = 0;
  let progressCalls = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        if (messageReads === 1) return Response.json([]);
        return Response.json([{
          info: { id: "msg_user", role: "user", time: { created: 900 } },
          parts: [{ type: "text", text: "Continue" }],
        }, {
          info: {
            id: "msg_new", role: "assistant", parentID: "msg_user",
            time: { created: 1_000, ...(statusReads >= 3 ? { completed: 2_000 } : {}) },
          },
          parts: statusReads >= 3
            ? [{ type: "text", text: "Done <promise>COMPLETE</promise>" }]
            : [{ type: "tool", tool: "edit", state: { input: { filePath: "src/a.ts" } } }],
        }]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") {
        statusReads += 1;
        return Response.json({ ses_child_12345678: { type: statusReads < 3 ? "busy" : "idle" } });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  await client.continueSession({
    sessionId: "ses_child_12345678",
    directory: "/runs/issue-7/run-abc",
    prompt: "Continue",
    onProgress: () => { progressCalls += 1; },
  });

  assert.equal(progressCalls, 2);
});

test("creates a standalone parent session for a GitHub-created Issue", async () => {
  let observed: unknown;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/home/opencode/workspace",
    fetchImpl: async (_url, init) => {
      observed = JSON.parse(String(init?.body));
      return Response.json({ id: "ses_parent_12345678" });
    },
  });

  const sessionId = await client.createParent({ title: "GitHub Issue #57: Fix login" });

  assert.equal(sessionId, "ses_parent_12345678");
  assert.deepEqual(observed, { title: "GitHub Issue #57: Fix login" });
});

test("reads the latest real generation metadata from an existing worker session", async () => {
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "configured-model",
    parentDirectory: "/workspace",
    fetchImpl: async () => Response.json([
      { info: { id: "msg_user_12345678", role: "user", time: { created: 1_000 } } },
      { info: { id: "msg_a_12345678", role: "assistant", parentID: "msg_user_12345678", modelID: "actual-model", time: { created: 1_100, completed: 20_000 } } },
      { info: { id: "msg_b_12345678", role: "assistant", parentID: "msg_user_12345678", modelID: "actual-model", time: { created: 20_100, completed: 102_000 } } },
    ]),
  });

  assert.deepEqual(await client.sessionGenerationMetadata("ses_child_12345678"), {
    modelId: "actual-model",
    generationStartedAt: "1970-01-01T00:00:01.100Z",
    generationCompletedAt: "1970-01-01T00:01:42.000Z",
  });
});

test("does not leak OpenCode credentials in API errors", async () => {
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "super-secret-internal-token-value",
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    fetchImpl: async () => new Response("bad", { status: 500 }),
  });
  await assert.rejects(
    client.createParent({ title: "Issue #1" }),
    (error: Error) => error.message.includes("HTTP 500") && !error.message.includes("super-secret"),
  );
});

test("bounds a stalled OpenCode API request instead of hanging the worker forever", async () => {
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    requestTimeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });

  await assert.rejects(client.createParent({ title: "Issue #1" }), /timed out/i);
});

test("rejects an oversized OpenCode API response", async () => {
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    maximumResponseBytes: 32,
    fetchImpl: async () => new Response(JSON.stringify({ id: `ses_${"x".repeat(64)}` })),
  });

  await assert.rejects(client.createParent({ title: "Issue #1" }), /too large/i);
});

test("keeps polling after a transient OpenCode read failure", async () => {
  let statusReads = 0;
  let messageReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        if (messageReads === 1) return Response.json([]);
        return Response.json([{
          info: { id: "msg_user", role: "user", time: { created: 900 } },
          parts: [{ type: "text", text: "Work" }],
        }, {
          info: { id: "msg_done", role: "assistant", parentID: "msg_user", modelID: "gpt-5.5", time: { created: 1_000, completed: 2_000 }, finish: "stop" },
          parts: [{ type: "text", text: "Done <promise>COMPLETE</promise>" }],
        }]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") {
        statusReads += 1;
        if (statusReads === 1) throw new TypeError("fetch failed");
        return Response.json({ ses_child_12345678: { type: "idle" } });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  const result = await client.continueSession({ sessionId: "ses_child_12345678", directory: "/workspace", prompt: "Work" });
  assert.match(result.text, /COMPLETE/);
  assert.equal(statusReads, 2);
});

test("reports an invalidated model credential instead of recommending a blind retry", async () => {
  let messageReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        if (messageReads === 1) return Response.json([]);
        return Response.json([{
          info: { id: "msg_user", role: "user", time: { created: 900 } },
          parts: [{ type: "text", text: "Work" }],
        }, {
          info: {
            id: "msg_failed", role: "assistant", parentID: "msg_user", modelID: "gpt-5.5",
            time: { created: 1_000, completed: 2_000 },
            error: { name: "APIError", data: { statusCode: 401, message: "Your authentication token has been invalidated." } },
          },
          parts: [],
        }]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") return Response.json({ ses_child_12345678: { type: "idle" } });
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  await assert.rejects(
    client.continueSession({ sessionId: "ses_child_12345678", directory: "/workspace", prompt: "Work" }),
    (error: Error & { code?: string }) => error.code === "model_authentication",
  );
  assert.equal((await client.sessionFailure("ses_child_12345678", "/workspace"))?.code, "model_authentication");
});

test("waits for explicit idle status and a completed response for the submitted user turn", async () => {
  let messageReads = 0;
  let statusReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        if (messageReads === 1) return Response.json([]);
        return Response.json([
          {
            info: { id: "msg_user_new", role: "user", time: { created: 1_000 } },
            parts: [{ type: "text", text: "Work" }],
          },
          {
            info: {
              id: "msg_assistant_new",
              role: "assistant",
              parentID: "msg_user_new",
              time: { created: 1_100, ...(statusReads >= 2 ? { completed: 2_000 } : {}) },
            },
            parts: [{
              type: "text",
              text: statusReads >= 2 ? "Final <promise>COMPLETE</promise>" : "partial response",
            }],
          },
        ]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") {
        statusReads += 1;
        return Response.json(statusReads >= 2 ? { ses_child_12345678: { type: "idle" } } : {});
      }
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  const result = await client.continueSession({
    sessionId: "ses_child_12345678",
    directory: "/workspace",
    prompt: "Work",
  });

  assert.equal(result.text, "Final <promise>COMPLETE</promise>");
  assert.equal(statusReads, 2);
});

test("accepts a completed response when OpenCode removes the idle session from its status map", async () => {
  let messageReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        if (messageReads === 1) return Response.json([]);
        return Response.json([
          {
            info: { id: "msg_user_new", role: "user", time: { created: 1_000 } },
            parts: [{ type: "text", text: "Work" }],
          },
          {
            info: {
              id: "msg_assistant_new",
              role: "assistant",
              parentID: "msg_user_new",
              time: { created: 1_100, completed: 2_000 },
            },
            parts: [{ type: "text", text: "Done <promise>COMPLETE</promise>" }],
          },
        ]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") return Response.json({});
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  const result = await client.continueSession({
    sessionId: "ses_child_12345678",
    directory: "/workspace",
    prompt: "Work",
  });

  assert.match(result.text, /COMPLETE/);
});

test("stops session polling when the runtime abort signal fires", async () => {
  let messageReads = 0;
  const controller = new AbortController();
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 1_000,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        return Response.json(messageReads === 1 ? [] : [
          { info: { id: "msg_user_new", role: "user" }, parts: [] },
        ]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") return Response.json({ ses_child_12345678: { type: "busy" } });
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  const running = client.continueSession({
    sessionId: "ses_child_12345678",
    directory: "/workspace",
    prompt: "Work",
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, /interrupted/i);
});

test("returns only the assistant response for the exact submitted user turn", async () => {
  let messageReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        if (messageReads === 1) return Response.json([]);
        return Response.json([
          { info: { id: "msg_user_ours", role: "user" }, parts: [{ type: "text", text: "Our prompt" }] },
          { info: { id: "msg_user_other", role: "user" }, parts: [{ type: "text", text: "Other prompt" }] },
          {
            info: { id: "msg_assistant_ours", role: "assistant", parentID: "msg_user_ours", time: { completed: 2_000 } },
            parts: [{ type: "text", text: "Our result <promise>COMPLETE</promise>" }],
          },
          {
            info: { id: "msg_assistant_other", role: "assistant", parentID: "msg_user_other", time: { completed: 2_100 } },
            parts: [{ type: "text", text: "Unrelated result" }],
          },
        ]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") return Response.json({});
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  const result = await client.continueSession({
    sessionId: "ses_child_12345678",
    directory: "/workspace",
    prompt: "Our prompt",
  });

  assert.equal(result.text, "Our result <promise>COMPLETE</promise>");
});

test("fails closed when multiple new user turns duplicate the submitted prompt", async () => {
  let messageReads = 0;
  const client = new OpenCodeClient({
    baseUrl: "http://opencode-web:4096",
    internalToken: "t".repeat(32),
    modelId: "gpt-5.5",
    parentDirectory: "/workspace",
    pollIntervalMs: 0,
    sessionTimeoutMs: 5_000,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads += 1;
        if (messageReads === 1) return Response.json([]);
        return Response.json([
          { info: { id: "msg_user_first", role: "user" }, parts: [{ type: "text", text: "Same prompt" }] },
          { info: { id: "msg_user_second", role: "user" }, parts: [{ type: "text", text: "Same prompt" }] },
          {
            info: { id: "msg_assistant_first", role: "assistant", parentID: "msg_user_first", time: { completed: 2_000 } },
            parts: [{ type: "text", text: "Potentially unrelated result" }],
          },
        ]);
      }
      if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      if (pathname === "/session/status") return Response.json({});
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });

  await assert.rejects(client.continueSession({
    sessionId: "ses_child_12345678",
    directory: "/workspace",
    prompt: "Same prompt",
  }), /ambiguous submitted user turn/);
});
