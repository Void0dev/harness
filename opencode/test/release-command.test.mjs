import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("merge is a normal release-agent command with constrained release flows", async () => {
  const command = await fs.readFile("opencode/web-config/commands/merge.md", "utf8");
  assert.match(command, /^---\n[\s\S]*\nagent: release\n---\n/);
  assert.match(command, /harness-github gh pr ready/);
  assert.match(command, /harness-github gh pr merge .*--auto --merge/);
  assert.match(command, /stage.*main|main.*stage/s);
  assert.match(command, /never|никогда/i);
  assert.match(command, /feature.*main|main.*feature/i);
});

test("Dockerfile installs git, gh, and the harness-github wrapper", async () => {
  const dockerfile = await fs.readFile("opencode/Dockerfile", "utf8");
  assert.match(dockerfile, /apt-get install[^\n]*git[^\n]*gh|apt-get install[\s\S]*\b(?:git[\s\S]*gh|gh[\s\S]*git)\b/);
  assert.match(dockerfile, /harness-github/);
  assert.match(dockerfile, /\/usr\/local\/bin\/harness-github/);
});

test("custom merge parser and runtime-control modules are removed", async () => {
  await assert.rejects(fs.access("opencode/lib/native-merge-command.mjs"), { code: "ENOENT" });
  await assert.rejects(fs.access("opencode/lib/runtime-control.mjs"), { code: "ENOENT" });
  const webEntry = await fs.readFile("opencode/web-entry.mjs", "utf8");
  assert.doesNotMatch(webEntry, /merge-not-available-in-runtime|merge-outcome|native-merge-command|runtime-control/);
});
