import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const serviceRoot = path.resolve(import.meta.dirname, "..");
const baseEnv = {
  ...process.env,
  INIT_CWD: serviceRoot,
  GITHUB_APP_ID: "12345",
  GITHUB_APP_INSTALLATION_ID: "67890",
  GITHUB_APP_PRIVATE_KEY_PATH: path.join(serviceRoot, "test-github-app.pem"),
  GITHUB_OWNER: "acme",
  GITHUB_REPO: "service",
  HARNESS_COMMAND_TOKEN: "c".repeat(32),
  OPENCODE_SERVER_URL: "http://opencode-runtime:4096",
  OPENCODE_INTERNAL_TOKEN: "t".repeat(32),
  OPENCODE_PARENT_DIRECTORY: "/home/opencode/workspace",
  OPENCODE_SERVER_USERNAME: "developer",
  OPENCODE_SERVER_PASSWORD: "p".repeat(32),
  OPENCODE_SESSION_SECRET: "s".repeat(32),
};

function load(env: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
    cwd: serviceRoot,
    env,
  });
}

test("requires valid GitHub App identifiers", async () => {
  await assert.rejects(load({ ...baseEnv, GITHUB_APP_ID: "0" }), /positive integer/);
  await assert.rejects(load({ ...baseEnv, GITHUB_APP_INSTALLATION_ID: "bad" }), /positive integer/);
});

test("requires an absolute GitHub App private-key path", async () => {
  await assert.rejects(load({ ...baseEnv, GITHUB_APP_PRIVATE_KEY_PATH: "relative.pem" }), /absolute path/);
});

test("rejects removed PAT and direct model-key configuration", async () => {
  await assert.rejects(load({ ...baseEnv, GITHUB_TOKEN: "obsolete" }), /no longer supported/);
  await assert.rejects(load({ ...baseEnv, VOID_AI_API_KEY: "secret" }), /only on OpenCode Runtime/);
});

test("requires bounded OpenCode server configuration", async () => {
  await assert.rejects(load({ ...baseEnv, OPENCODE_SERVER_URL: "http://user:pass@example.test" }), /plain HTTP/);
  await assert.rejects(load({ ...baseEnv, OPENCODE_INTERNAL_TOKEN: "short" }), /at least 32/);
  await assert.rejects(load({ ...baseEnv, OPENCODE_PARENT_DIRECTORY: "relative" }), /absolute path/);
});

test("accepts the direct OpenCode server configuration without sandbox variables", async () => {
  await load(baseEnv);
});

test("requires bounded public web credentials and session settings", async () => {
  await assert.rejects(load({ ...baseEnv, OPENCODE_SERVER_PASSWORD: "short" }), /at least 32/);
  await assert.rejects(load({ ...baseEnv, OPENCODE_SESSION_SECRET: "short" }), /at least 32/);
  await assert.rejects(load({ ...baseEnv, OPENCODE_PUBLIC_PORT: "80" }), /unprivileged port/);
  await assert.rejects(load({ ...baseEnv, OPENCODE_SESSION_TTL_SECONDS: "60" }), /between 86400/);
});

test("does not load a filesystem dotenv file in production", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-production-env-"));
  try {
    await fs.writeFile(path.join(root, ".env"), "VOID_AI_API_KEY=must-not-reach-worker\n");
    await load({ ...baseEnv, INIT_CWD: root, NODE_ENV: "production" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps filesystem dotenv loading for local development", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-harness-development-env-"));
  try {
    await fs.writeFile(path.join(root, ".env"), "WORKSPACE_RETENTION_HOURS=0\n");
    await assert.rejects(
      load({ ...baseEnv, INIT_CWD: root, NODE_ENV: "development" }),
      /positive number/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("requires a positive workspace retention period", async () => {
  await assert.rejects(load({ ...baseEnv, WORKSPACE_RETENTION_HOURS: "0" }), /positive number/);
  await load({ ...baseEnv, WORKSPACE_RETENTION_HOURS: "24" });
});
