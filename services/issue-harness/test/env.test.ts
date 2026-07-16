import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const serviceRoot = path.resolve(import.meta.dirname, "..");
const baseEnv = {
  ...process.env,
  INIT_CWD: serviceRoot,
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "acme",
  GITHUB_REPO: "service",
};

test("rejects an unknown Codex auth mode", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: { ...baseEnv, CODEX_AUTH_MODE: "typo" },
    }),
    /CODEX_AUTH_MODE must be one of/,
  );
});

test("requires a digest when production pinning is enabled", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: {
        ...baseEnv,
        CODEX_AUTH_MODE: "api-key",
        REQUIRE_PINNED_IMAGES: "true",
        SANDCASTLE_IMAGE: "sandbox:dev",
      },
    }),
    /SANDCASTLE_IMAGE must use an immutable sha256 digest/,
  );
});

test("rejects a dangerous harness data root", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "--eval", "import('./src/env.ts')"], {
      cwd: serviceRoot,
      env: {
        ...baseEnv,
        CODEX_AUTH_MODE: "api-key",
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
        CODEX_AUTH_MODE: "api-key",
        HARNESS_DATA_DIR: "/var/lib",
      },
    }),
    /HARNESS_DATA_DIR must be a per-repository child of \/opt\/issue-harness/,
  );
});
