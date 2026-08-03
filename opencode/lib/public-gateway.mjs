import http from "node:http";
import https from "node:https";
import {
  SESSION_COOKIE,
  cookieValue,
  createSessionCookie,
  credentialsMatch,
  loginPage,
  parseSessionCookie,
  safeNextPath,
} from "../auth.mjs";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

function parseUpstream(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname && url.pathname !== "/")
  ) throw new Error("upstreamUrl must be a plain HTTP(S) origin");
  return url;
}

function strongSecret(value, name) {
  if (typeof value !== "string" || value.length < 32 || /\s/.test(value)) {
    throw new Error(`${name} must contain at least 32 non-whitespace characters`);
  }
  return value;
}

function securityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

async function formBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8_192) throw new Error("Login form is too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function showLogin(response, options = {}, status = 200) {
  securityHeaders(response);
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(loginPage(options));
}

function secureRequest(request) {
  const forwarded = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  return forwarded === "https" || Boolean(request.socket.encrypted);
}

function loginKey(request) {
  return request.socket.remoteAddress ?? "unknown";
}

function proxyHeaders(headers, upstream, internalToken) {
  const forwarded = {
    ...headers,
    host: upstream.host,
    authorization: `Bearer ${internalToken}`,
  };
  delete forwarded.cookie;
  delete forwarded["accept-encoding"];
  return forwarded;
}

function proxyRequest(request, response, upstream, internalToken) {
  const transport = upstream.protocol === "https:" ? https : http;
  const target = new URL(request.url ?? "/", upstream);
  const outbound = transport.request(target, {
    method: request.method,
    headers: proxyHeaders(request.headers, upstream, internalToken),
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  outbound.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"runtime-unavailable"}');
  });
  request.pipe(outbound);
}

function proxyUpgrade(request, socket, head, upstream, internalToken) {
  const transport = upstream.protocol === "https:" ? https : http;
  const target = new URL(request.url ?? "/", upstream);
  const outbound = transport.request(target, {
    method: request.method,
    headers: proxyHeaders(request.headers, upstream, internalToken),
  });
  outbound.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const status = upstreamResponse.statusCode ?? 101;
    const statusText = upstreamResponse.statusMessage ?? "Switching Protocols";
    const headers = Object.entries(upstreamResponse.headers)
      .flatMap(([name, value]) => Array.isArray(value)
        ? value.map((item) => `${name}: ${item}`)
        : value === undefined ? [] : [`${name}: ${value}`])
      .join("\r\n");
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\n${headers}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  outbound.on("response", (upstreamResponse) => {
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
  });
  outbound.on("error", () => socket.destroy());
  outbound.end();
}

export async function startPublicGateway({
  port,
  upstreamUrl,
  username,
  password,
  sessionSecret,
  internalToken,
  sessionTtlSeconds = 86_400,
}) {
  const upstream = parseUpstream(upstreamUrl);
  const expectedPassword = strongSecret(password, "password");
  const signingSecret = strongSecret(sessionSecret, "sessionSecret");
  const runtimeToken = strongSecret(internalToken, "internalToken");
  if (typeof username !== "string" || !username || username.length > 128) {
    throw new Error("username must be a non-empty bounded string");
  }
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 86_400 || sessionTtlSeconds > 2_592_000) {
    throw new Error("sessionTtlSeconds must be between 86400 and 2592000");
  }

  const failures = new Map();
  const principal = (request) => {
    const session = parseSessionCookie(cookieValue(request.headers.cookie), { secret: signingSecret });
    return session?.username === username ? session.username : undefined;
  };
  const limited = (key) => {
    const record = failures.get(key);
    if (!record || record.resetAt <= Date.now()) {
      failures.delete(key);
      return false;
    }
    return record.count >= MAX_LOGIN_FAILURES;
  };
  const recordFailure = (key) => {
    const current = failures.get(key);
    failures.set(key, current && current.resetAt > Date.now()
      ? { count: current.count + 1, resetAt: current.resetAt }
      : { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://harness.local");
      if (request.method === "GET" && url.pathname === "/login") {
        if (principal(request)) {
          response.writeHead(303, { location: safeNextPath(url.searchParams.get("next")) });
          response.end();
          return;
        }
        showLogin(response, { next: safeNextPath(url.searchParams.get("next")) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/login") {
        try {
          const form = await formBody(request);
          const actualUsername = form.get("username") ?? "";
          const actualPassword = form.get("password") ?? "";
          const next = safeNextPath(form.get("next"));
          const key = loginKey(request);
          if (limited(key)) {
            showLogin(response, { next, limited: true }, 429);
            return;
          }
          if (!credentialsMatch(actualUsername, actualPassword, username, expectedPassword)) {
            recordFailure(key);
            showLogin(response, { next, invalid: true }, 401);
            return;
          }
          failures.delete(key);
          const session = createSessionCookie({
            username: actualUsername,
            secret: signingSecret,
            ttlSeconds: sessionTtlSeconds,
            secure: secureRequest(request),
          });
          response.writeHead(303, {
            location: next,
            "set-cookie": session.header,
            "cache-control": "no-store",
          });
          response.end();
        } catch {
          showLogin(response, { invalid: true }, 400);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/logout") {
        response.writeHead(303, {
          location: "/login",
          "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      if (!principal(request)) {
        if (request.headers.authorization) {
          response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
          response.end('{"error":"unauthorized"}');
          return;
        }
        response.writeHead(303, {
          location: `/login?next=${encodeURIComponent(safeNextPath(request.url))}`,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      proxyRequest(request, response, upstream, runtimeToken);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"gateway-failed"}');
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!principal(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyUpgrade(request, socket, head, upstream, runtimeToken);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
