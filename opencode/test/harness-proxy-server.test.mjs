import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startHarnessProxyServer } from "../lib/harness-proxy-server.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

test("proxies Issue and answer commands while keeping the real token server-side", async (t) => {
  const observed = [];
  const harness = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(request.url === "/commands/issues" ? 201 : 202, {
      "content-type": "application/json",
    });
    response.end(request.url === "/commands/issues" ? '{"number":57,"url":"https://example.test/57"}' : '{"issueNumber":57}');
  });
  const harnessPort = await listen(harness);
  t.after(() => harness.close());

  const proxy = await startHarnessProxyServer({
    port: 0,
    commandUrl: `http://127.0.0.1:${harnessPort}/commands/issues`,
    answerUrl: `http://127.0.0.1:${harnessPort}/commands/answers`,
    retryUrl: `http://127.0.0.1:${harnessPort}/commands/retries`,
    commandToken: "s".repeat(32),
  });
  t.after(() => proxy.close());
  const proxyPort = proxy.address().port;

  const issue = await fetch(`http://127.0.0.1:${proxyPort}/commands/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"text":"Change blue to red"}',
  });
  const answer = await fetch(`http://127.0.0.1:${proxyPort}/commands/answers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"text":"Use PostgreSQL"}',
  });
  const retry = await fetch(`http://127.0.0.1:${proxyPort}/commands/retries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"parentSessionId":"ses_parent_12345678"}',
  });

  assert.equal(issue.status, 201);
  assert.equal(answer.status, 202);
  assert.equal(retry.status, 202);
  assert.deepEqual(observed.map((item) => item.authorization), Array(3).fill(`Bearer ${"s".repeat(32)}`));
  assert.deepEqual(observed.map((item) => item.url), ["/commands/issues", "/commands/answers", "/commands/retries"]);
});

test("rejects unknown proxy routes and oversized bodies", async (t) => {
  const proxy = await startHarnessProxyServer({
    port: 0,
    commandUrl: "http://127.0.0.1:1/commands/issues",
    answerUrl: "http://127.0.0.1:1/commands/answers",
    retryUrl: "http://127.0.0.1:1/commands/retries",
    commandToken: "s".repeat(32),
    maximumBodyBytes: 16,
  });
  t.after(() => proxy.close());
  const port = proxy.address().port;

  assert.equal((await fetch(`http://127.0.0.1:${port}/unknown`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/commands/issues`, {
    method: "POST",
    body: "x".repeat(17),
  })).status, 413);
});
