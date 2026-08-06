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
    password: "short",
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
      password: "short",
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

test("public gateway transparently proxies authenticated command requests", async (t) => {
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
    body: JSON.stringify({ command: "merge", arguments: "stage #42" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proxied: true });
  assert.deepEqual(observed, [{
    url: "/session/ses_parent_12345678/command",
    body: JSON.stringify({ command: "merge", arguments: "stage #42" }),
  }]);
});
