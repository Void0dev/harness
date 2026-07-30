import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const renderConfig = path.resolve("opencode/render-config.mjs");

test("reads the model gateway key from the configured secret file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-secret-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const keyFile = path.join(root, "void-ai-api-key");
  const configHome = path.join(root, "config");
  await fs.writeFile(keyFile, "test-model-key\n", { mode: 0o400 });

  const environment = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configHome,
    VOID_AI_API_KEY_FILE: keyFile,
    VOID_AI_BASE_URL: "https://gateway.example.test/v1",
    VOID_AI_MODEL_ID: "test-model",
  };
  delete environment.VOID_AI_API_KEY;

  const result = spawnSync(process.execPath, [renderConfig, process.execPath, "-e", ""], {
    encoding: "utf8",
    env: environment,
  });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await fs.readFile(path.join(configHome, "opencode", "opencode.json"), "utf8"));
  assert.equal(config.provider.void.options.apiKey, "test-model-key");
});
