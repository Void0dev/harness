import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoRepositoryEnvironmentPassthrough,
  redactForGithub,
  withSanitizedProcessEnvironment,
} from "../src/security.js";

test("redacts configured credentials and common token formats", () => {
  const output = redactForGithub(
    "token=literal-secret ghp_abcdefghijklmnopqrstuvwxyz123456 sk-proj-abcdefghijklmnopqrstuvwxyz",
    ["literal-secret"],
  );

  assert.equal(output.includes("literal-secret"), false);
  assert.equal(output.includes("ghp_"), false);
  assert.equal(output.includes("sk-proj-"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("removes secret-shaped outer environment variables only for the sandbox operation", async () => {
  process.env.HARNESS_TEST_TOKEN = "secret";
  process.env.HARNESS_TEST_SAFE = "visible";
  await withSanitizedProcessEnvironment(async () => {
    assert.equal(process.env.HARNESS_TEST_TOKEN, undefined);
    assert.equal(process.env.HARNESS_TEST_SAFE, "visible");
  });
  assert.equal(process.env.HARNESS_TEST_TOKEN, "secret");
  delete process.env.HARNESS_TEST_TOKEN;
  delete process.env.HARNESS_TEST_SAFE;
});

test("rejects repository-controlled Sandcastle environment passthrough", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-security-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".sandcastle"));
  await fs.writeFile(path.join(workspace, ".sandcastle", ".env"), "GITHUB_TOKEN\n");
  await assert.rejects(assertNoRepositoryEnvironmentPassthrough(workspace), /environment pass-through/);
});
