import http from "node:http";
import { forwardHarnessProxy } from "./harness-proxy.mjs";

async function readBoundedRequestBody(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startHarnessProxyServer({
  port,
  commandUrl,
  answerUrl,
  retryUrl,
  commandToken,
  maximumBodyBytes = 64 * 1024,
}) {
  const server = http.createServer((request, response) => {
    void (async () => {
      const targetUrl = request.method === "POST" && request.url === "/commands/issues"
        ? commandUrl
        : request.method === "POST" && request.url === "/commands/answers"
          ? answerUrl
          : request.method === "POST" && request.url === "/commands/retries"
            ? retryUrl
          : undefined;
      if (!targetUrl) {
        response.writeHead(404).end();
        return;
      }
      try {
        const result = await forwardHarnessProxy({
          targetUrl,
          commandToken,
          body: await readBoundedRequestBody(request, maximumBodyBytes),
        });
        response.writeHead(result.status, {
          "content-type": result.contentType,
          "content-length": String(result.body.length),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(result.body);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "request body too large";
        response.writeHead(tooLarge ? 413 : 502, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(tooLarge ? '{"error":"request-too-large"}' : '{"error":"harness-unavailable"}');
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
