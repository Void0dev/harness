import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import { injectHarnessAssets } from "./lib/html-injection.mjs";
import { fetchBounded } from "./lib/bounded-fetch.mjs";
import { validatedHarnessUrl } from "./lib/harness-endpoint.mjs";
import { startHarnessProxyServer } from "./lib/harness-proxy-server.mjs";
import { forwardHarnessProxy } from "./lib/harness-proxy.mjs";
import { projectSessionMetadata } from "./lib/session-metadata.mjs";
import { runtimeRequestAuthorized } from "./lib/runtime-auth.mjs";
import { materializeCommandOutcome, materializeGitHubIssueConversation, materializeTaskMessages } from "./lib/native-task-message.mjs";
import { harnessCommandOutcome, nativeCommandPlan, persistThenDispatch } from "./lib/native-command.mjs";
import {
  captureSessionMessageIds,
  createNativeEventHub,
  createSseForwarder,
  findGitHubIssueParentSession,
  listGitHubIssueParentSessions,
  sessionCreatedEvent,
  sessionSnapshotEvents,
  taskCompletionEvents,
  terminalSessionIdleEvent,
} from "./lib/native-events.mjs";

const publicPort = Number.parseInt(process.env.OPENCODE_RUNTIME_PORT ?? process.env.OPENCODE_WEB_PORT ?? "4096", 10);
const upstreamPort = Number.parseInt(process.env.OPENCODE_UPSTREAM_PORT ?? "4097", 10);
const internalHarnessPort = Number.parseInt(process.env.OPENCODE_HARNESS_PROXY_PORT ?? "4098", 10);
const projectDirectory = process.env.OPENCODE_PROJECT_DIR ?? "/home/opencode/workspace";
const repositoryScope = `${process.env.GITHUB_OWNER ?? "unknown"}/${process.env.GITHUB_REPO ?? projectDirectory}`;
const opencodeDatabasePath = process.env.OPENCODE_DATABASE_PATH ?? "/home/opencode/.local/share/opencode/opencode.db";
const internalToken = process.env.OPENCODE_INTERNAL_TOKEN;
const harnessCommandToken = process.env.HARNESS_COMMAND_TOKEN;
const harnessCommandUrl = validatedHarnessUrl(process.env.HARNESS_COMMAND_URL ?? "", "Harness command URL");
const harnessAnswerUrl = validatedHarnessUrl(process.env.HARNESS_ANSWER_URL ?? "", "Harness answer URL");
const harnessRetryUrl = new URL("/commands/retries", harnessCommandUrl);
const harnessTasksUrl = process.env.HARNESS_TASKS_URL;
if (!internalToken || internalToken.length < 32) throw new Error("OPENCODE_INTERNAL_TOKEN must contain at least 32 characters");
if (!harnessCommandToken || harnessCommandToken.length < 32 || /\s/.test(harnessCommandToken)) {
  throw new Error("HARNESS_COMMAND_TOKEN must contain at least 32 non-whitespace characters");
}
if (!Number.isSafeInteger(internalHarnessPort) || internalHarnessPort < 1024 || internalHarnessPort > 65_535) {
  throw new Error("OPENCODE_HARNESS_PROXY_PORT must be a valid unprivileged port");
}
const parsedHarnessTasksUrl = new URL(harnessTasksUrl ?? "");
if (!["http:", "https:"].includes(parsedHarnessTasksUrl.protocol) || parsedHarnessTasksUrl.username || parsedHarnessTasksUrl.password) {
  throw new Error("HARNESS_TASKS_URL must be a plain HTTP(S) URL");
}
const encodedProject = Buffer.from(projectDirectory, "utf8").toString("base64url");
const projectRoute = `/${encodedProject}/session`;
const upstreamEnvironment = { ...process.env, BROWSER: "/bin/true" };
upstreamEnvironment.HARNESS_COMMAND_URL = `http://127.0.0.1:${internalHarnessPort}/commands/issues`;
upstreamEnvironment.HARNESS_ANSWER_URL = `http://127.0.0.1:${internalHarnessPort}/commands/answers`;
upstreamEnvironment.HARNESS_RETRY_URL = `http://127.0.0.1:${internalHarnessPort}/commands/retries`;
delete upstreamEnvironment.OPENCODE_INTERNAL_TOKEN;
delete upstreamEnvironment.HARNESS_COMMAND_TOKEN;
delete upstreamEnvironment.HARNESS_TASKS_URL;

const taskCardScript = await fs.readFile(new URL("./ui/task-card.mjs", import.meta.url));
const taskCardStyle = await fs.readFile(new URL("./ui/task-card.css", import.meta.url));

const harnessProxyServer = await startHarnessProxyServer({
  port: internalHarnessPort,
  commandUrl: harnessCommandUrl,
  answerUrl: harnessAnswerUrl,
  retryUrl: harnessRetryUrl,
  commandToken: harnessCommandToken,
});
const nativeEventHub = createNativeEventHub();

const opencode = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(upstreamPort)], {
  stdio: "inherit",
  env: upstreamEnvironment,
});
opencode.on("error", (error) => { console.error("Failed to start OpenCode Web", error); process.exit(1); });
opencode.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });

function authorized(request) {
  return runtimeRequestAuthorized({
    authorization: request.headers.authorization,
    internalToken,
  });
}

function proxyHeaders(headers) {
  const forwarded = { ...headers, host: `127.0.0.1:${upstreamPort}` };
  delete forwarded.authorization;
  delete forwarded.cookie;
  delete forwarded["accept-encoding"];
  return forwarded;
}

function proxyRequest(request, response) {
  const upstream = http.request({
    hostname: "127.0.0.1", port: upstreamPort, method: request.method, path: request.url,
    headers: proxyHeaders(request.headers),
  }, (upstreamResponse) => {
    const contentType = String(upstreamResponse.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().includes("text/html")) {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
      return;
    }
    const chunks = [];
    let bytes = 0;
    upstreamResponse.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        upstreamResponse.destroy(new Error("OpenCode HTML response is too large"));
        return;
      }
      chunks.push(chunk);
    });
    upstreamResponse.on("end", () => {
      const body = Buffer.from(injectHarnessAssets(Buffer.concat(chunks).toString("utf8")), "utf8");
      const headers = { ...upstreamResponse.headers, "content-length": String(body.length) };
      delete headers["content-encoding"];
      delete headers.etag;
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      response.end(body);
    });
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`OpenCode Web is starting: ${error.message}\n`);
  });
  request.pipe(upstream);
}

function proxyBufferedRequest(request, response, body) {
  const headers = proxyHeaders(request.headers);
  headers["content-length"] = String(body.length);
  const upstream = http.request({
    hostname: "127.0.0.1", port: upstreamPort, method: request.method, path: request.url, headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`OpenCode Web is starting: ${error.message}\n`);
  });
  upstream.end(body);
}

async function readRequestBody(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxyNativeHarnessCommand(request, response, url) {
  let body;
  try {
    body = await readRequestBody(request);
  } catch {
    response.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"request-too-large"}');
    return;
  }
  let payload;
  try { payload = JSON.parse(body.toString("utf8")); } catch {}
  const plan = nativeCommandPlan({
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    body: payload,
  });
  if (!plan) {
    proxyBufferedRequest(request, response, body);
    return;
  }

  try {
    const persisted = await persistThenDispatch({
      plan,
      persist: async (command) => fetchBounded({
        url: new URL(command.upstreamPath, `http://127.0.0.1:${upstreamPort}`),
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(command.promptBody)),
        timeoutMs: 10_000,
        maximumBytes: 8 * 1024 * 1024,
      }),
      dispatch: async (command) => {
        try {
          const targetUrl = command.command === "issue" ? harnessCommandUrl : harnessRetryUrl;
          const commandBody = command.command === "issue"
            ? {
                text: command.argumentsText,
                parentSessionId: command.sessionID,
                ...(command.model?.providerID === "void" && typeof command.model.modelID === "string"
                  ? { modelId: command.model.modelID }
                  : {}),
              }
            : { parentSessionId: command.sessionID, ...(command.argumentsText ? { instruction: command.argumentsText } : {}) };
          const result = await forwardHarnessProxy({
            targetUrl,
            commandToken: harnessCommandToken,
            body: Buffer.from(JSON.stringify(commandBody)),
          });
          return harnessCommandOutcome(command.command, result);
        } catch {
          return {
            status: "failed",
            failure: "harness-unreachable",
          };
        }
      },
      onOutcome: (outcome) => {
        const previousMessageIds = captureSessionMessageIds(opencodeDatabasePath, outcome.sessionID);
        const materialized = materializeCommandOutcome({
          dbPath: opencodeDatabasePath,
          parentSessionId: outcome.sessionID,
          messageID: outcome.messageID,
          commandText: outcome.commandText,
          outcome,
          projectDirectory,
        });
        if (materialized.changed) {
          const events = sessionSnapshotEvents(opencodeDatabasePath, outcome.sessionID, previousMessageIds);
          if (outcome.status !== "accepted") events.push(terminalSessionIdleEvent(outcome.sessionID));
          nativeEventHub.publish(events);
        }
      },
      onError: (error) => {
        console.error("Harness native command failed", error);
      },
    });
    response.writeHead(persisted.status, {
      "content-type": persisted.contentType || "application/json; charset=utf-8",
      "content-length": String(persisted.body.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(persisted.body);
  } catch (error) {
    console.error("OpenCode native command persistence failed", error);
    response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"opencode-command-unavailable"}');
  }
}

function proxyEventRequest(request, response, pathname) {
  const upstream = http.request({
    hostname: "127.0.0.1", port: upstreamPort, method: request.method, path: request.url,
    headers: proxyHeaders(request.headers),
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    delete headers["content-length"];
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    const forwarder = createSseForwarder((frame) => {
      if (!response.destroyed && !response.writableEnded) response.write(frame);
    });
    const unsubscribe = nativeEventHub.subscribe(
      (frames) => {
        if (!response.destroyed && !response.writableEnded) response.write(frames);
      },
      { pathname, directory: projectDirectory },
    );
    const cleanup = () => unsubscribe();
    upstreamResponse.on("data", (chunk) => forwarder.push(chunk));
    upstreamResponse.on("end", () => {
      forwarder.end();
      cleanup();
      response.end();
    });
    upstreamResponse.on("error", () => {
      cleanup();
      response.destroy();
    });
    response.on("close", () => {
      cleanup();
      upstream.destroy();
    });
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`OpenCode event stream is starting: ${error.message}\n`);
  });
  request.pipe(upstream);
}

function serveAsset(response, bytes, contentType) {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}


function materializeTaskViews(parentSessionId, tasks) {
  const previousMessageIds = captureSessionMessageIds(opencodeDatabasePath, parentSessionId);
  const materialized = materializeTaskMessages({
    dbPath: opencodeDatabasePath,
    parentSessionId,
    tasks,
    projectDirectory,
  });
  if (materialized.changed) {
    nativeEventHub.publish(taskCompletionEvents(
      sessionSnapshotEvents(opencodeDatabasePath, parentSessionId, previousMessageIds),
      parentSessionId,
      tasks.length > 0 && tasks.every((task) => ["finished", "failed", "awaiting_human"].includes(task?.status)),
    ));
  }
  return materialized;
}

async function createGitHubIssueConversation(request, response) {
  let payload;
  try {
    payload = JSON.parse((await readRequestBody(request, 128 * 1024)).toString("utf8"));
  } catch {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"invalid-request"}');
    return;
  }
  const issueNumber = payload?.issueNumber;
  const title = payload?.title;
  const body = payload?.body;
  const comments = payload?.comments;
  const modelId = payload?.modelId;
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0
    || typeof title !== "string" || !title.trim() || title.length > 120
    || typeof body !== "string" || body.length > 50_000
    || typeof comments !== "string" || comments.length > 50_000
    || typeof modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(modelId)) {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"invalid-request"}');
    return;
  }
  try {
    let parentSessionId = findGitHubIssueParentSession(opencodeDatabasePath, issueNumber, projectDirectory);
    if (!parentSessionId) {
      const createUrl = new URL("/session", `http://127.0.0.1:${upstreamPort}`);
      createUrl.searchParams.set("directory", projectDirectory);
      const created = await fetchBounded({
        url: createUrl,
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ title: `GitHub Issue #${issueNumber}: ${title.trim()}` })),
        timeoutMs: 10_000,
        maximumBytes: 64 * 1024,
      });
      if (created.status < 200 || created.status >= 300) throw new Error("OpenCode parent session creation failed");
      parentSessionId = JSON.parse(created.body.toString("utf8"))?.id;
    }
    if (typeof parentSessionId !== "string" || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)) {
      throw new Error("OpenCode returned an invalid parent session");
    }
    const previousMessageIds = captureSessionMessageIds(opencodeDatabasePath, parentSessionId);
    materializeGitHubIssueConversation({
      dbPath: opencodeDatabasePath,
      parentSessionId,
      issue: { title: title.trim(), body, comments },
      task: {
        schemaVersion: 1,
        issueNumber,
        title: title.trim(),
        status: "running",
        stages: ["accepted"],
        modelId,
        updatedAt: new Date().toISOString(),
      },
      projectDirectory,
    });
    const createdEvent = sessionCreatedEvent(opencodeDatabasePath, parentSessionId);
    nativeEventHub.publish([
      ...(createdEvent ? [createdEvent] : []),
      ...sessionSnapshotEvents(opencodeDatabasePath, parentSessionId, previousMessageIds),
    ]);
    const result = Buffer.from(JSON.stringify({ parentSessionId }));
    response.writeHead(201, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(result.length),
      "cache-control": "no-store",
    });
    response.end(result);
  } catch (error) {
    console.error("GitHub Issue conversation creation failed", error);
    response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"opencode-unavailable"}');
  }
}

async function materializeInternalTaskView(request, response) {
  let payload;
  try {
    payload = JSON.parse((await readRequestBody(request, 128 * 1024)).toString("utf8"));
  } catch {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"invalid-request"}');
    return;
  }
  const parentSessionId = payload?.parentSessionId;
  const task = payload?.task;
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId) || !task || typeof task !== "object") {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"invalid-request"}');
    return;
  }
  try {
    const materialized = materializeTaskViews(parentSessionId, [task]);
    const body = Buffer.from(JSON.stringify({ materialized: materialized.changed }));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    console.error("Harness task update materialization failed", error);
    response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"opencode-unavailable"}');
  }
}

async function proxyTaskViews(requestUrl, response) {
  const parentSessionId = requestUrl.searchParams.get("parentSessionId") ?? "";
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(parentSessionId)) {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"invalid-parent-session"}');
    return;
  }
  const endpoint = new URL(parsedHarnessTasksUrl);
  endpoint.searchParams.set("parentSessionId", parentSessionId);
  try {
    const previousMessageIds = captureSessionMessageIds(opencodeDatabasePath, parentSessionId);
    const upstream = await fetchBounded({
      url: endpoint,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${harnessCommandToken}`,
      },
      timeoutMs: 10_000,
      maximumBytes: 2 * 1024 * 1024,
    });
    if (upstream.status !== 200) {
      response.writeHead(upstream.status, {
        "content-type": upstream.contentType,
        "content-length": String(upstream.body.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(upstream.body);
      return;
    }
    const payload = JSON.parse(upstream.body.toString("utf8"));
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const materialized = materializeTaskMessages({
      dbPath: opencodeDatabasePath,
      parentSessionId,
      tasks,
      projectDirectory,
    });
    if (materialized.changed) {
      nativeEventHub.publish(taskCompletionEvents(
        sessionSnapshotEvents(opencodeDatabasePath, parentSessionId, previousMessageIds),
        parentSessionId,
        tasks.every((task) => ["finished", "failed", "awaiting_human"].includes(task?.status)),
      ));
    }
    const body = Buffer.from(JSON.stringify({ ...payload, materialized: materialized.changed }));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch (error) {
    console.error("Harness task materialization failed", error);
    response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"harness-unavailable"}');
  }
}

async function proxySessionMetadata(requestUrl, response) {
  const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
  if (!/^ses_[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
    response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"invalid-session"}');
    return;
  }
  const endpoint = new URL(`/session/${sessionId}/message`, `http://127.0.0.1:${upstreamPort}`);
  endpoint.searchParams.set("directory", projectDirectory);
  try {
    const upstream = await fetchBounded({
      url: endpoint,
      headers: { Accept: "application/json" },
      timeoutMs: 10_000,
      maximumBytes: 8 * 1024 * 1024,
    });
    if (upstream.status < 200 || upstream.status >= 300) throw new Error("OpenCode metadata request failed");
    const messages = JSON.parse(upstream.body.toString("utf8"));
    const body = Buffer.from(JSON.stringify(projectSessionMetadata(messages)));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"opencode-metadata-unavailable"}');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://opencode.local");
  if (!authorized(request)) {
    response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"unauthorized"}');
    return;
  }
  if (["/login", "/logout"].includes(url.pathname)) {
    response.writeHead(404).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/__harness/task-card.mjs") {
    serveAsset(response, taskCardScript, "text/javascript; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/__harness/task-card.css") {
    serveAsset(response, taskCardStyle, "text/css; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/__harness/api/tasks") {
    await proxyTaskViews(url, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/__harness/api/session-metadata") {
    await proxySessionMetadata(url, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/__harness/api/github-parent-sessions") {
    const body = Buffer.from(JSON.stringify({
      scope: repositoryScope,
      sessions: listGitHubIssueParentSessions(opencodeDatabasePath, projectDirectory),
    }));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  if (request.method === "POST" && url.pathname === "/__harness/internal/github-issue-conversations") {
    await createGitHubIssueConversation(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/__harness/internal/task-messages") {
    await materializeInternalTaskView(request, response);
    return;
  }
  if (request.method === "POST" && /^\/session\/ses_[A-Za-z0-9_-]{8,128}\/command$/.test(url.pathname)) {
    await proxyNativeHarnessCommand(request, response, url);
    return;
  }
  if (request.method === "GET" && (url.pathname === "/event" || url.pathname === "/global/event")) {
    proxyEventRequest(request, response, url.pathname);
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(302, { location: projectRoute, "cache-control": "no-store" });
    response.end();
    return;
  }
  proxyRequest(request, response);
});

server.on("upgrade", (request, socket, head) => {
  if (!authorized(request)) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
  const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
    const headers = Object.entries(proxyHeaders(request.headers))
      .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`]).join("\r\n");
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(publicPort, "0.0.0.0", () => {
  console.log(`Private OpenCode runtime: http://localhost:${publicPort}${projectRoute}`);
});
function shutdown(signal) {
  harnessProxyServer.close();
  server.close(() => process.exit(0));
  opencode.kill(signal);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
