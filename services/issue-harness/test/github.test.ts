import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_OWNER = "acme";
process.env.GITHUB_REPO = "service";

test("reuses an existing open pull request without creating a duplicate", async () => {
  const { GithubTracker } = await import("../src/github.js");
  let creates = 0;
  const fake = {
    rest: {
      pulls: {
        list: async () => ({ data: [{ html_url: "https://github.com/acme/service/pull/7" }] }),
        create: async () => {
          creates += 1;
          return { data: { html_url: "unexpected" } };
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  const url = await tracker.findOrCreatePullRequest(7, "codex/issue-7", "Fix", "Body");

  assert.equal(url, "https://github.com/acme/service/pull/7");
  assert.equal(creates, 0);
});

test("recovers when pull request creation succeeded but the response failed", async () => {
  const { GithubTracker } = await import("../src/github.js");
  let lists = 0;
  const fake = {
    rest: {
      pulls: {
        list: async () => ({
          data: ++lists === 1 ? [] : [{ html_url: "https://github.com/acme/service/pull/8" }],
        }),
        create: async () => {
          throw new Error("connection reset after create");
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  const url = await tracker.findOrCreatePullRequest(8, "codex/issue-8", "Fix", "Body");

  assert.equal(url, "https://github.com/acme/service/pull/8");
  assert.equal(lists, 2);
});

test("adds the destination routing label before removing old labels", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const events: string[] = [];
  const fake = {
    rest: {
      issues: {
        addLabels: async ({ labels }: { labels: string[] }) => {
          events.push(`add:${labels.join(",")}`);
        },
        removeLabel: async ({ name }: { name: string }) => {
          events.push(`remove:${name}`);
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  await tracker.moveStatus(42, "running");

  assert.equal(events[0], "add:ai:running");
  assert.equal(events.includes("remove:ai:running"), false);
  assert.ok(events.includes("remove:ai:todo"));
});
