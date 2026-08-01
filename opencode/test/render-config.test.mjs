import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

const renderConfig = path.resolve("opencode/render-config.mjs");

test("reads the model gateway key from the configured secret file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-secret-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const keyFile = path.join(root, "void-ai-api-key");
  const configHome = path.join(root, "config");
  await fs.writeFile(keyFile, "test-model-key\n", { mode: 0o400 });
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer test-model-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-image" }, { id: "model-video" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const environment = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configHome,
    VOID_AI_API_KEY_FILE: keyFile,
    VOID_AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  };
  delete environment.VOID_AI_API_KEY;

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [renderConfig, process.execPath, "-e", ""], { env: environment });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stderr }));
  });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await fs.readFile(path.join(configHome, "opencode", "opencode.json"), "utf8"));
  assert.equal(config.provider.void.options.apiKey, "test-model-key");
  assert.deepEqual(config.enabled_providers, ["void", "void-image", "void-video"]);
  assert.equal(config.model, "void/model-a");
  assert.deepEqual(config.provider.void.models, {
    "model-a": { name: "model-a" },
  });
  assert.deepEqual(config.provider["void-image"].models, { "model-image": { name: "model-image" } });
  assert.deepEqual(config.provider["void-video"].models, { "model-video": { name: "model-video" } });
});
