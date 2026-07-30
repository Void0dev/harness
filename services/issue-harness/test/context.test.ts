import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { refreshContextCheckout, withFreshContext } from "../src/context.js";

const execFileAsync = promisify(execFile);

test("clones and refreshes one read-only context checkout from stage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const contextDir = path.join(root, "context");

  await git(root, "init", "--bare", remote);
  await fs.mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.test");
  await fs.writeFile(path.join(source, "version.txt"), "one\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "initial");
  await git(source, "switch", "-c", "stage");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "stage");

  const first = await refreshContextCheckout({
    contextDir,
    remoteUrl: remote,
    baseBranch: "stage",
  });
  assert.equal(await fs.readFile(path.join(contextDir, "version.txt"), "utf8"), "one\n");
  assert.match(first.revision, /^[0-9a-f]{40}$/);

  await fs.writeFile(path.join(source, "version.txt"), "two\n");
  await git(source, "add", "version.txt");
  await git(source, "commit", "-m", "update");
  await git(source, "push", "origin", "stage");

  const second = await refreshContextCheckout({
    contextDir,
    remoteUrl: remote,
    baseBranch: "stage",
  });
  assert.equal(await fs.readFile(path.join(contextDir, "version.txt"), "utf8"), "two\n");
  assert.notEqual(second.revision, first.revision);
  assert.equal((await git(contextDir, "branch", "--show-current")).trim(), "");
});

test("refreshes stage before an ordinary parent-chat message is released to OpenCode", async () => {
  const events: string[] = [];
  const handle = withFreshContext(
    async () => { events.push("refresh-stage"); },
    async (text: string) => { events.push(`answer:${text}`); return "ok"; },
  );

  assert.equal(await handle("current background"), "ok");
  assert.deepEqual(events, ["refresh-stage", "answer:current background"]);
});

async function git(cwd: string, ...args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  });
  return result.stdout;
}
