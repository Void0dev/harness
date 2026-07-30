import assert from "node:assert/strict";
import test from "node:test";

delete process.env.OPENAI_API_KEY;
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_INSTALLATION_ID = "67890";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/tmp/test-github-app.pem";
process.env.GITHUB_OWNER = "acme";
process.env.GITHUB_REPO = "service";
process.env.HARNESS_COMMAND_TOKEN = "c".repeat(32);
process.env.OPENCODE_SERVER_URL = "http://opencode-web:4096";
process.env.OPENCODE_INTERNAL_TOKEN = "t".repeat(32);
process.env.OPENCODE_PARENT_DIRECTORY = "/home/opencode/workspace";

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

  const url = await tracker.findOrCreatePullRequest(7, "opencode/issue-7", "Fix", "Body");

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

  const url = await tracker.findOrCreatePullRequest(8, "opencode/issue-8", "Fix", "Body");

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

test("verifies repository access and both required branches", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const branches: string[] = [];
  const fake = {
    rest: {
      repos: {
        get: async () => ({ data: { full_name: "acme/service" } }),
        getBranch: async ({ branch }: { branch: string }) => {
          branches.push(branch);
          return { data: { name: branch } };
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  await tracker.assertRepositoryAccess();

  assert.deepEqual(branches, ["main", "stage"]);
});

test("creates an Issue through the App-authenticated tracker", async () => {
  const { GithubTracker } = await import("../src/github.js");
  let observed: unknown;
  const fake = {
    rest: {
      issues: {
        create: async (request: unknown) => {
          observed = request;
          return { data: { number: 57, html_url: "https://github.com/acme/service/issues/57" } };
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  const result = await tracker.createIssue({
    title: "Add health endpoint",
    body: "Details",
    labels: ["ai:todo"],
  });

  assert.deepEqual(observed, {
    owner: "acme",
    repo: "service",
    title: "Add health endpoint",
    body: "Details",
    labels: ["ai:todo"],
  });
  assert.deepEqual(result, { number: 57, url: "https://github.com/acme/service/issues/57" });
});

test("accepts an ai:todo Issue created by the repository GitHub App", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const appIssue = {
    number: 57,
    title: "Fix background colour",
    body: "Change blue to red",
    labels: [{ name: "ai:todo" }],
    author_association: "NONE",
  };
  const fake = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
      },
    },
    paginate: async (_method: unknown, options: { labels: string }) =>
      options.labels === "ai:todo" ? [appIssue] : [],
  };
  const tracker = new GithubTracker(fake as never);

  const issue = await tracker.nextIssue();

  assert.equal(issue?.number, 57);
});

test("finds unfinished work only for the matching OpenCode parent", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const issues = [
    {
      number: 57,
      title: "First",
      body: "Task\n\n<!-- opencode-harness-parent: ses_parent_12345678 -->",
      labels: [{ name: "ai:running" }],
    },
    {
      number: 58,
      title: "Second",
      body: "Task\n\n<!-- opencode-harness-parent: ses_other_12345678 -->",
      labels: [{ name: "ai:todo" }],
    },
  ];
  const fake = {
    rest: { issues: { listForRepo: async () => ({ data: [] }) } },
    paginate: async (_method: unknown, options: { labels: string }) =>
      issues.filter((issue) => issue.labels.some((label) => label.name === options.labels)),
  };
  const tracker = new GithubTracker(fake as never);

  assert.equal((await tracker.findBlockingIssue("ses_parent_12345678"))?.number, 57);
  assert.equal(await tracker.findBlockingIssue("ses_free_12345678"), null);
});

test("moves needs-human work out of running and removes needs-human when resumed", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const events: string[] = [];
  const fake = {
    rest: {
      issues: {
        addLabels: async ({ labels }: { labels: string[] }) => events.push(`add:${labels.join(",")}`),
        removeLabel: async ({ name }: { name: string }) => events.push(`remove:${name}`),
        createComment: async () => ({ data: {} }),
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  await tracker.needsHuman(57, "Question");
  assert.equal(events[0], "add:ai:needs-human");
  assert.ok(events.includes("remove:ai:running"));

  events.length = 0;
  await tracker.moveStatus(57, "todo");
  assert.equal(events[0], "add:ai:todo");
  assert.ok(events.includes("remove:ai:needs-human"));
});

test("prefers an existing running Issue over newly queued work", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const fake = {
    rest: { issues: { listForRepo: async () => ({ data: [] }) } },
    paginate: async (_method: unknown, options: { labels: string }) => options.labels === "ai:running"
      ? [{ number: 1, title: "Running", body: "", labels: [{ name: "ai:running" }] }]
      : [{ number: 2, title: "Todo", body: "", labels: [{ name: "ai:todo" }] }],
  };
  const tracker = new GithubTracker(fake as never);
  assert.equal((await tracker.nextIssue())?.number, 1);
});
