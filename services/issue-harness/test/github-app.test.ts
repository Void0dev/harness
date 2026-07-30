import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("loads the PEM once and returns current installation credentials", async () => {
  const { createGitHubAppCredentials } = await import("../src/github-app.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "github-app-test-"));
  const privateKeyPath = path.join(directory, "app.pem");
  await fs.writeFile(privateKeyPath, "test-private-key", { mode: 0o600 });
  const authOptions: unknown[] = [];
  const octokit = { rest: {} };

  try {
    const credentials = await createGitHubAppCredentials(
      { appId: 123, installationId: 456, privateKeyPath },
      {
        createAuth: (options) => {
          authOptions.push(options);
          return async ({ type }) => {
            assert.equal(type, "installation");
            return { token: "installation-token" };
          };
        },
        createOctokit: (options) => {
          authOptions.push(options);
          return octokit as never;
        },
      },
    );

    assert.equal(credentials.octokit, octokit);
    assert.equal(await credentials.getToken(), "installation-token");
    assert.deepEqual(authOptions, [
      { appId: 123, installationId: 456, privateKey: "test-private-key" },
      { appId: 123, installationId: 456, privateKey: "test-private-key" },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects an invalid installation authentication response without exposing the PEM", async () => {
  const { createGitHubAppCredentials } = await import("../src/github-app.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "github-app-test-"));
  const privateKeyPath = path.join(directory, "app.pem");
  await fs.writeFile(privateKeyPath, "private-material-that-must-stay-secret", { mode: 0o600 });

  try {
    const credentials = await createGitHubAppCredentials(
      { appId: 123, installationId: 456, privateKeyPath },
      {
        createAuth: () => async () => ({}),
        createOctokit: () => ({ rest: {} }) as never,
      },
    );
    await assert.rejects(credentials.getToken(), /invalid installation token response/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
