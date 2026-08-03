import assert from "node:assert/strict";
import test from "node:test";
import { harnessGithubCommand } from "../lib/harness-github.mjs";

test("runs gh with an ephemeral installation token", () => {
  const parent = { PATH: "/usr/bin", GH_TOKEN: "stale", GITHUB_TOKEN: "stale-github" };
  const child = harnessGithubCommand({
    argv: ["gh", "pr", "view", "42"],
    env: parent,
    token: "ghs_fresh",
  });

  assert.equal(child.command, "gh");
  assert.deepEqual(child.args, ["pr", "view", "42"]);
  assert.equal(child.env.GH_TOKEN, "ghs_fresh");
  assert.equal(child.env.GITHUB_TOKEN, undefined);
  assert.equal(parent.GH_TOKEN, "stale");
});

test("runs git with a process-local GitHub authorization extraHeader", () => {
  const child = harnessGithubCommand({
    argv: ["git", "fetch", "origin", "stage"],
    env: {
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.askPass",
      GIT_CONFIG_VALUE_0: "",
    },
    token: "ghs_fresh",
  });

  assert.equal(child.command, "git");
  assert.deepEqual(child.args, ["fetch", "origin", "stage"]);
  assert.equal(child.env.GIT_CONFIG_COUNT, "2");
  assert.equal(child.env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraHeader");
  assert.equal(
    child.env.GIT_CONFIG_VALUE_1,
    `Authorization: Basic ${Buffer.from("x-access-token:ghs_fresh").toString("base64")}`,
  );
  assert.equal(child.env.GH_TOKEN, undefined);
});

test("rejects commands other than gh and git", () => {
  assert.throws(() => harnessGithubCommand({
    argv: ["bash", "-lc", "env"],
    env: {},
    token: "ghs_fresh",
  }), /gh or git/);
});
