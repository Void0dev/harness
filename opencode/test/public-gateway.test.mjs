import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startPublicGateway } from "../lib/public-gateway.mjs";

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

test("public gateway rejects unauthenticated traffic and authenticates before proxying", async (t) => {
  const observed = [];
  const runtime = http.createServer((request, response) => {
    observed.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"runtime":true}');
  });
  const runtimePort = await listen(runtime);
  t.after(() => runtime.close());

  const gateway = await startPublicGateway({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${runtimePort}`,
    username: "developer",
    password: "correct-password-that-is-long-enough",
    sessionSecret: "s".repeat(32),
    internalToken: "i".repeat(32),
    sessionTtlSeconds: 86_400,
  });
  t.after(() => gateway.close());
  const gatewayPort = gateway.address().port;
  const base = `http://127.0.0.1:${gatewayPort}`;

  const anonymous = await fetch(`${base}/project/session`, { redirect: "manual" });
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.headers.get("location"), /^\/login\?next=/);
  assert.equal(observed.length, 0);

  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "developer",
      password: "correct-password-that-is-long-enough",
      next: "/project/session",
    }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);

  const proxied = await fetch(`${base}/project/session`, {
    headers: { cookie, authorization: "Bearer attacker-controlled" },
  });
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { runtime: true });
  assert.deepEqual(observed, [{
    url: "/project/session",
    authorization: `Bearer ${"i".repeat(32)}`,
    cookie: undefined,
  }]);
});

test("public gateway rejects upstream URLs with embedded credentials", async () => {
  await assert.rejects(startPublicGateway({
    port: 0,
    upstreamUrl: "http://user:pass@example.test",
    username: "developer",
    password: "correct-password-that-is-long-enough",
    sessionSecret: "s".repeat(32),
    internalToken: "i".repeat(32),
    sessionTtlSeconds: 86_400,
  }), /plain HTTP/);
});

test("public gateway proxies authenticated non-merge commands without requiring an Origin header", async (t) => {
  const observed = [];
  const runtime = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ url: request.url, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"proxied":true}');
  });
  const runtimePort = await listen(runtime);
  t.after(() => runtime.close());
  const gateway = await startPublicGateway({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${runtimePort}`,
    username: "developer",
    password: "correct-password-that-is-long-enough",
    sessionSecret: "s".repeat(32),
    internalToken: "i".repeat(32),
  });
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "developer",
      password: "correct-password-that-is-long-enough",
      next: "/",
    }),
  });

  const response = await fetch(`${base}/session/ses_parent_12345678/command`, {
    method: "POST",
    headers: { cookie: login.headers.get("set-cookie"), "content-type": "application/json" },
    body: JSON.stringify({ command: "issue", arguments: "Add a test" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proxied: true });
  assert.deepEqual(observed, [{
    url: "/session/ses_parent_12345678/command",
    body: JSON.stringify({ command: "issue", arguments: "Add a test" }),
  }]);
});

test("public gateway dispatches merge only from an authenticated same-origin request", async (t) => {
  const runtimeRequests = [];
  const runtime = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    runtimeRequests.push({ url: request.url, body: Buffer.concat(chunks).toString("utf8") });
    if (request.url?.startsWith("/session/") && request.url.includes("/message")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"info":{"id":"msg_user_12345678"}}');
      return;
    }
    if (request.url === "/__runtime/control/merge-outcome") {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  const runtimePort = await listen(runtime);
  t.after(() => runtime.close());
  const merges = [];
  const gateway = await startPublicGateway({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${runtimePort}`,
    username: "developer",
    password: "correct-password-that-is-long-enough",
    sessionSecret: "s".repeat(32),
    internalToken: "i".repeat(32),
    submitMerge: async (request) => {
      merges.push(request);
      return { status: "merged", target: "stage", pullRequestNumber: 81, mergeSha: "a".repeat(40) };
    },
  });
  t.after(() => gateway.close());
  const port = gateway.address().port;
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "developer",
      password: "correct-password-that-is-long-enough",
      next: "/",
    }),
  });
  const cookie = login.headers.get("set-cookie");

  const forbidden = await fetch(`${base}/session/ses_parent_12345678/command`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ command: "merge", arguments: "stage", requestedBy: "attacker" }),
  });
  assert.equal(forbidden.status, 403);

  const accepted = await fetch(`${base}/session/ses_parent_12345678/command`, {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ command: "merge", arguments: "stage #42", requestedBy: "attacker" }),
  });
  assert.equal(accepted.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(merges, [{
    parentSessionId: "ses_parent_12345678",
    argumentsText: "stage #42",
    requestedBy: "developer",
  }]);
  assert.equal(runtimeRequests.length, 2);
  assert.match(runtimeRequests[0].url, /\/session\/ses_parent_12345678\/message/);
  const materialized = JSON.parse(runtimeRequests[1].body);
  assert.equal(materialized.outcome.command, "merge");
  assert.equal(materialized.outcome.status, "merged");
});

test("public gateway acknowledges merge only after dispatch and outcome materialization", async (t) => {
  let releaseMerge;
  const mergeGate = new Promise((resolve) => { releaseMerge = resolve; });
  const runtime = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url?.startsWith("/session/") && request.url.includes("/message")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"info":{"id":"msg_user_12345678"}}');
      return;
    }
    if (request.url === "/__runtime/control/merge-outcome") {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  const runtimePort = await listen(runtime);
  t.after(() => runtime.close());
  const gateway = await startPublicGateway({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${runtimePort}`,
    username: "developer",
    password: "correct-password-that-is-long-enough",
    sessionSecret: "s".repeat(32),
    internalToken: "i".repeat(32),
    submitMerge: async () => {
      await mergeGate;
      return { status: "merged", target: "stage", pullRequestNumber: 81, mergeSha: "a".repeat(40) };
    },
  });
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "developer", password: "correct-password-that-is-long-enough", next: "/" }),
  });
  let settled = false;
  const pending = fetch(`${base}/session/ses_parent_12345678/command`, {
    method: "POST",
    headers: { cookie: login.headers.get("set-cookie"), origin: base, "content-type": "application/json" },
    body: JSON.stringify({ command: "merge", arguments: "stage #42" }),
  }).then((response) => { settled = true; return response; });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  releaseMerge();
  assert.equal((await pending).status, 200);
});

test("public gateway fails the request when merge outcome materialization is rejected", async (t) => {
  const runtime = http.createServer((request, response) => {
    if (request.url?.startsWith("/session/") && request.url.includes("/message")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"info":{"id":"msg_user_12345678"}}');
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"write-failed"}');
  });
  const runtimePort = await listen(runtime);
  t.after(() => runtime.close());
  const gateway = await startPublicGateway({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${runtimePort}`,
    username: "developer",
    password: "correct-password-that-is-long-enough",
    sessionSecret: "s".repeat(32),
    internalToken: "i".repeat(32),
    submitMerge: async () => ({ status: "merged", target: "stage", pullRequestNumber: 81, mergeSha: "a".repeat(40) }),
  });
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "developer", password: "correct-password-that-is-long-enough", next: "/" }),
  });

  const response = await fetch(`${base}/session/ses_parent_12345678/command`, {
    method: "POST",
    headers: { cookie: login.headers.get("set-cookie"), origin: base, "content-type": "application/json" },
    body: JSON.stringify({ command: "merge", arguments: "stage #42" }),
  });

  assert.equal(response.status, 502);
});
