import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoRepositoryEnvironmentPassthrough,
  assertNoHighConfidenceSecrets,
  acquireProcessLock,
  ensureRuntimeIdentity,
  redactForGithub,
  publicHarnessStatus,
  withSanitizedProcessEnvironment,
  sandboxControlEnvironment,
  ensurePrivateRuntimeDirectory,
} from "../src/security.js";

test("redacts configured credentials and common token formats", () => {
  const output = redactForGithub(
    [
      "token=literal-secret",
      `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`,
      `sk-proj-${"abcdefghijklmnopqrstuvwxyz"}`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.aGVsbG93b3JsZHNpZ25hdHVyZQ",
      `oauth_token=${["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-")}`,
      "api_key=abcdefghijklmnopqrstuvwxyz123456",
    ].join(" "),
    ["literal-secret"],
  );

  assert.equal(output.includes("literal-secret"), false);
  assert.equal(output.includes("ghp_"), false);
  assert.equal(output.includes("sk-proj-"), false);
  assert.equal(output.includes("eyJhbGci"), false);
  assert.equal(output.includes("xoxb-"), false);
  assert.equal(output.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("maps untrusted details to a bounded generic status", () => {
  const status = publicHarnessStatus("human-attention");
  assert.deepEqual(JSON.parse(status), {
    schemaVersion: 1,
    code: "agent_needs_input",
    message: "The coding agent needs operator input. Review trusted local logs before resuming.",
  });
  assert.equal(status.length < 512, true);
  assert.doesNotMatch(status, /raw attacker detail/i);
});

test("rejects exact and high-confidence credentials before publication", () => {
  assert.throws(
    () => assertNoHighConfidenceSecrets(
      Buffer.from("+password=exact-deploy-secret\n"),
      ["exact-deploy-secret"],
    ),
    /credential material/,
  );
  assert.throws(
    () => assertNoHighConfidenceSecrets(
      Buffer.from("+Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX2J5dGVzX2hlcmU\n"),
      [],
    ),
    /credential material/,
  );
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

test("does not pass outer Docker control into the coding sandbox", () => {
  process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
  process.env.DOCKER_TLS_VERIFY = "1";
  process.env.DOCKER_CERT_PATH = "/host/certs";
  try {
    assert.deepEqual(sandboxControlEnvironment(), {
      DOCKER_HOST: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
    });
  } finally {
    delete process.env.DOCKER_HOST;
    delete process.env.DOCKER_TLS_VERIFY;
    delete process.env.DOCKER_CERT_PATH;
  }
});

test("creates and repairs agent runtime directories with owner-only permissions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-runtime-permissions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "codex");
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await fs.chmod(directory, 0o755);

  await ensurePrivateRuntimeDirectory(directory);

  const mode = (await fs.stat(directory)).mode & 0o777;
  assert.equal(mode, 0o700);
});

test("binds a data root to one immutable repository identity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-runtime-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await ensureRuntimeIdentity(root, "acme/service");
  await ensureRuntimeIdentity(root, "acme/service");
  await assert.rejects(
    ensureRuntimeIdentity(root, "other/service"),
    /belongs to a different repository/,
  );
  assert.equal((await fs.stat(path.join(root, "repository-identity.json"))).mode & 0o777, 0o400);
});

test("prevents two runtime processes from owning one data root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-process-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = await acquireProcessLock(root);
  await assert.rejects(acquireProcessLock(root), /already owns HARNESS_DATA_DIR/);
  await lock.release();
  const reacquired = await acquireProcessLock(root);
  await reacquired.release();
});
