import assert from "node:assert/strict";
import test from "node:test";
import { createIssueFromCommand, issueCommandMessage } from "../lib/issue.mjs";

test("keeps the successful /issue command in the parent chat history", () => {
  assert.equal(
    issueCommandMessage(57, "Add a health endpoint"),
    "/issue Add a health endpoint\n\n<!-- opencode-harness-issue: 57 -->",
  );
});

test("rejects an empty /issue command", async () => {
  await assert.rejects(
    createIssueFromCommand({
      argumentsText: "   ",
      parentSessionId: "ses_parent_12345678",
      harnessUrl: "http://issue-harness:3000/commands/issues",
      commandToken: "command-secret",
    }),
    /Issue text is required/,
  );
});

test("creates an Issue through Harness without receiving GitHub credentials", async () => {
  let observed;
  const result = await createIssueFromCommand({
    argumentsText: "Add a health endpoint",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://issue-harness:3000/commands/issues",
    commandToken: "command-secret",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({
        number: 57,
        url: "https://github.com/acme/service/issues/57",
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(observed.url, "http://issue-harness:3000/commands/issues");
  assert.equal(observed.init.headers.Authorization, "Bearer command-secret");
  assert.deepEqual(JSON.parse(observed.init.body), {
    text: "Add a health endpoint",
    parentSessionId: "ses_parent_12345678",
  });
  assert.deepEqual(result, {
    number: 57,
    url: "https://github.com/acme/service/issues/57",
  });
});

test("returns a visible busy result instead of throwing when another Issue is queued", async () => {
  const result = await createIssueFromCommand({
    argumentsText: "Add another feature",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://issue-harness:3000/commands/issues",
    commandToken: "command-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      error: "issue-processing-busy",
      issueNumber: 1,
    }), { status: 409, headers: { "content-type": "application/json" } }),
  });

  assert.deepEqual(result, { busy: true, issueNumber: 1 });
});

test("uses the loopback Harness proxy without exposing the command token to OpenCode", async () => {
  let observed;
  const result = await createIssueFromCommand({
    argumentsText: "Add a health endpoint",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://127.0.0.1:4098/commands/issues",
    commandToken: "",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return Response.json({ number: 57, url: "https://github.com/acme/service/issues/57" }, { status: 201 });
    },
  });

  assert.equal(observed.url, "http://127.0.0.1:4098/commands/issues");
  assert.equal(observed.init.headers.Authorization, undefined);
  assert.equal(result.number, 57);
});

test("still requires a command token for a non-loopback Harness URL", async () => {
  await assert.rejects(createIssueFromCommand({
    argumentsText: "Add a health endpoint",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://issue-harness:3000/commands/issues",
    commandToken: "",
  }), /command token/i);
});

test("times out Issue creation instead of leaving the OpenCode command pending forever", async () => {
  await assert.rejects(createIssueFromCommand({
    argumentsText: "Add a health endpoint",
    parentSessionId: "ses_parent_12345678",
    harnessUrl: "http://127.0.0.1:4098/commands/issues",
    commandToken: "",
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  }), /timed out/i);
});
