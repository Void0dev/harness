import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireProcessLock,
  ensureRuntimeIdentity,
  ensurePrivateRuntimeDirectory,
  ensureSharedRuntimeParentDirectory,
  ensureSharedRuntimeDirectory,
} from "../src/security.js";

test("creates and repairs agent runtime directories with owner-only permissions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-runtime-permissions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "opencode");
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await fs.chmod(directory, 0o755);

  await ensurePrivateRuntimeDirectory(directory);

  const mode = (await fs.stat(directory)).mode & 0o777;
  assert.equal(mode, 0o700);
});

test("creates shared parent directories without group write permission", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-shared-parent-permissions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "runs");
  await fs.mkdir(directory, { recursive: true, mode: 0o2770 });
  await fs.chmod(directory, 0o2770);

  await ensureSharedRuntimeParentDirectory(directory);

  assert.equal((await fs.stat(directory)).mode & 0o7777, 0o2750);
});

test("creates and repairs cross-UID runtime directories with setgid group access", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-shared-permissions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "runs");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);

  await ensureSharedRuntimeDirectory(directory);

  const mode = (await fs.stat(directory)).mode & 0o7777;
  assert.equal(mode, 0o2770);
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
