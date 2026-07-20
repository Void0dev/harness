import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const serviceRoot = path.resolve(import.meta.dirname, "..");
const { OPENAI_API_KEY: _ambientOpenAiApiKey, ...cleanProcessEnv } = process.env;
const baseEnv = {
  ...cleanProcessEnv,
  INIT_CWD: serviceRoot,
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "acme",
  GITHUB_REPO: "service",
  CODEX_AUTH_MODE: "broker",
  CODEX_BROKER_URL: "http://codex-broker:8080/v1",
  CODEX_BROKER_AUDIENCE: "codex-broker",
  CODEX_BROKER_SIGNING_SECRET: "s".repeat(32),
  SANDBOX_NETWORK: "codex-broker-internal",
  DOCKER_HOST: "unix:///run/sandbox-engine/docker.sock",
  SANDBOX_DOCKER_DAEMON_ID: "rootless-daemon",
};

test("rejects direct Codex auth modes for untrusted execution", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: { ...baseEnv, CODEX_AUTH_MODE: "api-key" },
    }),
    /direct API-key and subscription modes are forbidden/,
  );
});

test("rejects an upstream API key on the harness process", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: { ...baseEnv, OPENAI_API_KEY: ["sk", "upstream-secret-that-must-not-enter-sandbox"].join("-") },
    }),
    /OPENAI_API_KEY must not be configured/,
  );
});

test("rejects the conventional rootful Docker socket before execution", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: { ...baseEnv, DOCKER_HOST: "unix:///var/run/docker.sock" },
    }),
    /conventional rootful Docker socket is forbidden/,
  );
});

test("rejects unbounded sandbox CPU configuration", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: { ...baseEnv, SANDBOX_CPUS: "1000" },
    }),
    /SANDBOX_CPUS must be between/,
  );
});

test("requires the canonical digest coordinate when production pinning is enabled", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: {
        ...baseEnv,
        REQUIRE_PINNED_IMAGES: "true",
        SANDCASTLE_IMAGE: "sandbox:dev",
      },
    }),
    /SANDCASTLE_IMAGE must use the canonical image coordinate and lowercase sha256 digest/,
  );
});

test("accepts the canonical sandbox digest when production pinning is enabled", async () => {
  await execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
    cwd: serviceRoot,
    env: {
      ...baseEnv,
      REQUIRE_PINNED_IMAGES: "true",
      SANDCASTLE_IMAGE: `ghcr.io/void0dev/sandcastle-harness@sha256:${"a".repeat(64)}`,
    },
  });
});

test("rejects a weak configured health-details token", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: {
        ...baseEnv,
        HARNESS_HEALTH_DETAILS_TOKEN: "too-short",
      },
    }),
    /HARNESS_HEALTH_DETAILS_TOKEN must contain at least 32 characters/,
  );
});

test("rejects a dangerous harness data root", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: {
        ...baseEnv,
        HARNESS_DATA_DIR: "/",
      },
    }),
    /HARNESS_DATA_DIR must be a per-repository child of \/opt\/issue-harness/,
  );
});

test("rejects a shared harness parent", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: {
        ...baseEnv,
        HARNESS_DATA_DIR: "/var/lib",
      },
    }),
    /HARNESS_DATA_DIR must be a per-repository child of \/opt\/issue-harness/,
  );
});
