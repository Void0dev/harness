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
process.env.OPENCODE_SERVER_USERNAME = "operator";
process.env.OPENCODE_SERVER_PASSWORD = "p".repeat(32);
process.env.OPENCODE_SESSION_SECRET = "s".repeat(32);

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
        listForRepo: async (options: { labels: string }) => ({
          data: options.labels === "ai:todo" ? [appIssue] : [],
        }),
      },
    },
    paginate: async () => { throw new Error("Issue polling must be bounded"); },
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
    rest: {
      search: {
        issuesAndPullRequests: async ({ q }: { q: string }) => ({
          data: {
            items: q.includes("ses_parent_12345678") ? issues : [],
          },
        }),
      },
    },
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
        createComment: async () => ({
          data: {
            id: 9001,
            created_at: "2026-08-03T10:00:00.000Z",
          },
        }),
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.needsHuman(57, "Question"), {
    id: 9001,
    createdAt: "2026-08-03T10:00:00.000Z",
  });
  assert.equal(events[0], "add:ai:needs-human");
  assert.ok(events.includes("remove:ai:running"));

  events.length = 0;
  await tracker.moveStatus(57, "todo");
  assert.equal(events[0], "add:ai:todo");
  assert.ok(events.includes("remove:ai:needs-human"));
});

test("reuses an existing Harness human question after restart", async () => {
  const { GithubTracker } = await import("../src/github.js");
  let creates = 0;
  const question = "Which database should be used?";
  const fake = {
    rest: { issues: {
      addLabels: async () => undefined,
      removeLabel: async () => undefined,
      get: async () => ({ data: { comments: 1 } }),
      listComments: async () => ({ data: [{
        id: 9001,
        body: `Human attention needed:\n\n${question}`,
        created_at: "2026-08-03T10:00:00.000Z",
        author_association: "NONE",
        user: { login: "harness[bot]", type: "Bot" },
      }] }),
      createComment: async () => {
        creates += 1;
        throw new Error("must not create a duplicate question");
      },
    } },
  };
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.ensureHumanQuestion(57, question), {
    id: 9001,
    createdAt: "2026-08-03T10:00:00.000Z",
  });
  assert.equal(creates, 0);
});

test("returns only trusted human replies posted after the Harness question", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const comments = [
    {
      id: 90,
      body: "Old context",
      created_at: "2026-08-03T09:00:00.000Z",
      author_association: "OWNER",
      user: { login: "alice", type: "User" },
    },
    {
      id: 101,
      body: "Untrusted suggestion",
      created_at: "2026-08-03T10:01:00.000Z",
      author_association: "NONE",
      user: { login: "stranger", type: "User" },
    },
    {
      id: 102,
      body: "Harness status",
      created_at: "2026-08-03T10:02:00.000Z",
      author_association: "MEMBER",
      user: { login: "harness[bot]", type: "Bot" },
    },
    {
      id: 104,
      body: "Second answer",
      created_at: "2026-08-03T10:04:00.000Z",
      author_association: "COLLABORATOR",
      user: { login: "bob", type: "User" },
    },
    {
      id: 103,
      body: "First answer",
      created_at: "2026-08-03T10:03:00.000Z",
      author_association: "OWNER",
      user: { login: "alice", type: "User" },
    },
  ];
  const fake = {
    rest: { issues: {
      get: async () => ({ data: { comments: comments.length } }),
      listComments: async () => ({ data: comments }),
    } },
    paginate: async () => { throw new Error("Comment polling must be bounded"); },
  };
  const tracker = new GithubTracker(fake as never);

  assert.equal(typeof (tracker as unknown as { humanReplies?: unknown }).humanReplies, "function");
  assert.deepEqual(await (tracker as unknown as {
    humanReplies(issueNumber: number, afterCommentId: number): Promise<unknown>;
  }).humanReplies(57, 100), [
    {
      id: 103,
      author: "alice",
      body: "First answer",
      createdAt: "2026-08-03T10:03:00.000Z",
    },
    {
      id: 104,
      author: "bob",
      body: "Second answer",
      createdAt: "2026-08-03T10:04:00.000Z",
    },
  ]);
});

test("reads at most five newest comment pages for human replies", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const pages: number[] = [];
  const fake = {
    rest: { issues: {
      get: async () => ({ data: { comments: 900 } }),
      listComments: async ({ page }: { page: number }) => {
        pages.push(page);
        return { data: [] };
      },
    } },
  };
  const tracker = new GithubTracker(fake as never);

  await tracker.humanReplies(57, 100);

  assert.deepEqual(pages, [9, 8, 7, 6, 5]);
});

test("prefers an existing running Issue over newly queued work", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const fake = {
    rest: { issues: { listForRepo: async (options: { labels: string }) => ({
      data: options.labels === "ai:running"
        ? [{ number: 1, title: "Running", body: "", labels: [{ name: "ai:running" }] }]
        : [{ number: 2, title: "Todo", body: "", labels: [{ name: "ai:todo" }] }],
    }) } },
    paginate: async () => { throw new Error("Issue polling must be bounded"); },
  };
  const tracker = new GithubTracker(fake as never);
  assert.equal((await tracker.nextIssue())?.number, 1);
});

test("finds the Harness stage pull request by issue and branch", async () => {
  const { GithubTracker } = await import("../src/github.js");
  let observed: unknown;
  const fake = {
    rest: {
      pulls: {
        list: async (request: unknown) => {
          observed = request;
          return {
            data: [
              {
                number: 91,
                html_url: "https://github.com/acme/service/pull/91",
                title: "Fix #91: Health",
                state: "open",
                draft: true,
                merged_at: null,
                head: { ref: "opencode/issue-91", sha: "feature91" },
                base: { ref: "stage", sha: "stage0" },
              },
            ],
          };
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.findHarnessPullRequest(91, "opencode/issue-91"), {
    number: 91,
    url: "https://github.com/acme/service/pull/91",
    state: "open",
    draft: true,
    merged: false,
    headBranch: "opencode/issue-91",
    headSha: "feature91",
    baseBranch: "stage",
    baseSha: "stage0",
  });
  assert.deepEqual(observed, {
    owner: "acme",
    repo: "service",
    state: "open",
    base: "stage",
    head: "acme:opencode/issue-91",
    per_page: 100,
  });
});
