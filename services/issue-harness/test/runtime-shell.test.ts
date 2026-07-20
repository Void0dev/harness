import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve(import.meta.dirname, "..", "verify_runtime.sh");
const startScript = path.resolve(import.meta.dirname, "..", "start.sh");

test("startup owns a nonblocking kernel lock for the repository data root", async () => {
  const source = await fs.readFile(startScript, "utf8");
  assert.match(source, /exec \{harness_lock_fd\}>/);
  assert.match(source, /flock -n "\$harness_lock_fd"/);
  assert.match(source, /Another issue-harness process already owns HARNESS_DATA_DIR/);
});

test("rejects a remapped rootful daemon even through the dedicated socket path", async (t) => {
  const fixture = await daemonFixture(t, '["name=userns"]');
  await assert.rejects(
    verify(fixture),
    /does not attest rootless SecurityOptions/,
  );
});

test("accepts only the attested rootless local daemon", async (t) => {
  const fixture = await daemonFixture(t, '["name=seccomp,profile=builtin","name=rootless"]');
  await verify(fixture);
  await assert.rejects(
    verify({ ...fixture, daemonId: "other-daemon" }),
    /identity does not match/,
  );
});

async function daemonFixture(t: TestContext, securityOptions: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-daemon-attestation-"));
  const socketPath = path.join(root, "docker.sock");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh\ncase "$*" in\n  *SecurityOptions*) printf '%s\\n' "$STUB_SECURITY_OPTIONS" ;;\n  *) printf '%s\\n' "$STUB_DAEMON_ID" ;;\nesac\n`,
    { mode: 0o755 },
  );
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, socketPath, bin, securityOptions, daemonId: "rootless-daemon" };
}

async function verify(fixture: Awaited<ReturnType<typeof daemonFixture>>) {
  await execFileAsync("bash", ["-c", 'source "$1"; verify_sandbox_docker_daemon "$2"', "bash", script, fixture.root], {
    env: {
      PATH: `${fixture.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      DOCKER_HOST: `unix://${fixture.socketPath}`,
      SANDBOX_DOCKER_SOCKET_PATH: fixture.socketPath,
      SANDBOX_DOCKER_DAEMON_ID: fixture.daemonId,
      STUB_DAEMON_ID: "rootless-daemon",
      STUB_SECURITY_OPTIONS: fixture.securityOptions,
    },
  });
}
