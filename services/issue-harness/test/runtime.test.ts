import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDockerDaemonAttestation,
  hardenedDockerRunArguments,
  mintBrokerToken,
} from "../src/runtime.js";

test("sandbox run arguments enforce bounded rootless-container isolation", () => {
  const args = hardenedDockerRunArguments({
    containerName: "sandbox-test",
    imageName: `ghcr.io/acme/sandbox@sha256:${"a".repeat(64)}`,
    user: "10001:10001",
    network: "codex-broker-internal",
    memoryMb: 4096,
    cpus: 2,
    pidsLimit: 256,
    tmpfsMb: 256,
    environment: { OPENAI_API_KEY: "ephemeral" },
    mounts: [{ hostPath: "/trusted/worktree", sandboxPath: "/home/agent/workspace" }],
  });

  assert.deepEqual(args.slice(0, 16), [
    "run", "-d", "--name", "sandbox-test",
    "--user", "10001:10001",
    "--memory", "4096m",
    "--cpus", "2",
    "--pids-limit", "256",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
  ]);
  assert.equal(args.includes("--read-only"), true);
  assert.equal(args.includes("never"), true);
  assert.equal(args.includes("--network"), true);
  assert.equal(args.includes("none"), false);
  assert.equal(args.some((value) => value.includes("/home/agent/.codex")), false);
  assert.equal(args.some((value) => value.includes("/var/run/docker.sock")), false);
});

test("broker token is signed, short-lived, and scoped to one run", () => {
  const token = mintBrokerToken({
    signingSecret: "s".repeat(32),
    audience: "codex-broker",
    repository: "acme/service",
    issueNumber: 42,
    ttlSeconds: 900,
    nowSeconds: 1_000,
    tokenId: "run-id",
  });
  const [, payload] = token.split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.deepEqual(decoded, {
    iss: "issue-harness",
    aud: "codex-broker",
    sub: "acme/service",
    issue: 42,
    jti: "run-id",
    iat: 1_000,
    exp: 1_900,
  });
});

test("rejects unbounded sandbox resource requests", () => {
  assert.throws(() => hardenedDockerRunArguments({
    containerName: "sandbox-test",
    imageName: "sandbox:test",
    user: "10001:10001",
    network: "codex-broker-internal",
    memoryMb: Number.MAX_SAFE_INTEGER,
    cpus: 2,
    pidsLimit: 256,
    tmpfsMb: 256,
    environment: {},
    mounts: [],
  }), /memory limit is outside/);
});

test("direct runtime attestation rejects remapped rootful and unexpected daemons", () => {
  assert.throws(
    () => assertDockerDaemonAttestation("daemon-a", '["name=userns"]', "daemon-a"),
    /does not attest rootless/,
  );
  assert.throws(
    () => assertDockerDaemonAttestation("daemon-a", '["name=rootless"]', "daemon-b"),
    /identity does not match/,
  );
  assert.doesNotThrow(
    () => assertDockerDaemonAttestation("daemon-a", '["name=rootless"]', "daemon-a"),
  );
});
