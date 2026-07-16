import { createServer, type Server } from "node:http";

export async function startHealthServer(options: {
  port: number;
  repository: string;
  workspaceOrigin?: string;
  isReady?: () => boolean;
}): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    const ready = options.isReady?.() ?? true;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: ready ? "ok" : "degraded",
        repository: options.repository,
        ...(options.workspaceOrigin ? { workspaceOrigin: options.workspaceOrigin } : {}),
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
