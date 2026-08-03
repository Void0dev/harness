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
    rest: { issues: { listComments: async () => ({ data: [] }) } },
    paginate: async () => comments,
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

test("publishes feature work only as a draft pull request into stage", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = {
    rest: {
      pulls: {
        list: async (request: unknown) => {
          calls.push(["list", request]);
          return { data: [] };
        },
        create: async (request: unknown) => {
          calls.push(["create", request]);
          return { data: { html_url: "https://github.com/acme/service/pull/91" } };
        },
        merge: async () => {
          throw new Error("default publication must never merge");
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  assert.equal(
    await tracker.findOrCreatePullRequest(91, "opencode/issue-91", "Health", "Body"),
    "https://github.com/acme/service/pull/91",
  );
  assert.deepEqual(calls, [
    ["list", {
      owner: "acme",
      repo: "service",
      state: "open",
      base: "stage",
      head: "acme:opencode/issue-91",
      per_page: 10,
    }],
    ["create", {
      owner: "acme",
      repo: "service",
      base: "stage",
      head: "opencode/issue-91",
      title: "Fix #91: Health",
      body: "Body",
      maintainer_can_modify: true,
      draft: true,
    }],
  ]);
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
    state: "all",
    base: "stage",
    head: "acme:opencode/issue-91",
    per_page: 100,
  });
});

test("marks a draft stage pull request ready through GitHub GraphQL", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = {
    graphql: async (query: string, variables: unknown) => {
      calls.push(["graphql", query, variables]);
      return {
        markPullRequestReadyForReview: {
          pullRequest: { number: 91, url: "https://github.com/acme/service/pull/91", isDraft: false },
        },
      };
    },
    rest: {
      pulls: {
        get: async (request: unknown) => {
          calls.push(["get", request]);
          return { data: pullRequest({ draft: true }) };
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.markStagePullRequestReady(91), {
    kind: "ready",
    pullRequestNumber: 91,
    url: "https://github.com/acme/service/pull/91",
  });
  assert.deepEqual(calls[0], ["get", { owner: "acme", repo: "service", pull_number: 91 }]);
  assert.match((calls[1] as [string, string])[1], /markPullRequestReadyForReview/);
  assert.deepEqual((calls[1] as [string, string, unknown])[2], { pullRequestId: "PR_node_91" });
});

test("inspects mergeability, checks, and review blockers without merging", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = mergeInspectionGithub(calls, {
    pull: pullRequest({ mergeable: false, mergeable_state: "blocked" }),
    checks: [
      { name: "test", status: "completed", conclusion: "failure", html_url: "https://ci.example/test" },
    ],
    reviews: [
      { id: 1, state: "CHANGES_REQUESTED", submitted_at: "2026-08-03T10:00:00Z", user: { login: "alice" } },
    ],
  });
  const tracker = new GithubTracker(fake as never);

  const result = await tracker.inspectPullRequest(91);

  assert.equal(result.readiness, "blocked");
  assert.deepEqual(result.blockers.map((blocker) => blocker.kind), ["mergeability", "check", "review"]);
  assert.deepEqual(calls, [
    ["get", { owner: "acme", repo: "service", pull_number: 91 }],
    ["checks", { owner: "acme", repo: "service", ref: "feature91", filter: "latest", per_page: 100 }],
    ["reviews", { owner: "acme", repo: "service", pull_number: 91, per_page: 100 }],
  ]);
});

test("merges a ready feature pull request into stage with its exact head SHA", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = mergeInspectionGithub(calls, {
    pull: pullRequest(),
    merge: { merged: true, sha: "stage91", message: "Pull Request successfully merged" },
  });
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.mergeStagePullRequest(91), {
    kind: "merged",
    pullRequestNumber: 91,
    url: "https://github.com/acme/service/pull/91",
    mergeSha: "stage91",
  });
  assert.deepEqual(calls.at(-1), ["merge", {
    owner: "acme",
    repo: "service",
    pull_number: 91,
    sha: "feature91",
    merge_method: "merge",
  }]);
});

test("replays an already merged stage pull request without another merge call", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = mergeInspectionGithub(calls, {
    pull: pullRequest({ merged: true, state: "closed", merge_commit_sha: "stage91" }),
  });
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.mergeStagePullRequest(91), {
    kind: "already-merged",
    pullRequestNumber: 91,
    url: "https://github.com/acme/service/pull/91",
    mergeSha: "stage91",
  });
  assert.equal(calls.some(([kind]) => kind === "merge"), false);
});

test("refuses unknown mergeability without calling the merge endpoint", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = mergeInspectionGithub(calls, {
    pull: pullRequest({ mergeable: null, mergeable_state: "unknown" }),
  });
  const tracker = new GithubTracker(fake as never);

  const result = await tracker.mergeStagePullRequest(91);

  assert.equal(result.kind, "unknown");
  assert.equal(calls.some(([kind]) => kind === "merge"), false);
});

test("reads release heads and creates a ready stage-to-main promotion pull request", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = {
    rest: {
      repos: {
        getBranch: async (request: { branch: string }) => {
          calls.push(["branch", request]);
          return { data: { commit: { sha: request.branch === "stage" ? "stage91" : "main90" } } };
        },
      },
      pulls: {
        list: async (request: unknown) => {
          calls.push(["list", request]);
          return { data: [] };
        },
        create: async (request: unknown) => {
          calls.push(["create", request]);
          return { data: promotionPullRequest() };
        },
      },
    },
  };
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.readReleaseHeads(), { stageSha: "stage91", mainSha: "main90" });
  calls.length = 0;
  const result = await tracker.findOrCreatePromotionPullRequest("Release 91", "Promote tested stage");

  assert.equal(result.kind, "created");
  assert.equal(result.pullRequest.number, 92);
  assert.deepEqual(calls.at(-1), ["create", {
    owner: "acme",
    repo: "service",
    base: "main",
    head: "stage",
    title: "Release 91",
    body: "Promote tested stage",
    maintainer_can_modify: true,
    draft: false,
  }]);
});

test("reuses and merges a stage-to-main promotion but rejects feature-to-main", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const promotion = promotionPullRequest();
  const fake = mergeInspectionGithub(calls, {
    pull: promotion,
    merge: { merged: true, sha: "main92", message: "Pull Request successfully merged" },
    branches: { stage: "stage91", main: "main90" },
    listedPulls: [promotion],
  });
  const tracker = new GithubTracker(fake as never);

  const reused = await tracker.findOrCreatePromotionPullRequest("Release 91", "Promote tested stage");
  assert.equal(reused.kind, "reused");
  assert.deepEqual(await tracker.mergePromotionPullRequest(92), {
    kind: "merged",
    pullRequestNumber: 92,
    url: "https://github.com/acme/service/pull/92",
    mergeSha: "main92",
  });

  calls.length = 0;
  fake.rest.pulls.get = async (request: unknown) => {
    calls.push(["get", request]);
    return { data: pullRequest({ base: { ref: "main", sha: "main90" } }) };
  };
  const blocked = await tracker.mergePromotionPullRequest(91);
  assert.equal(blocked.kind, "blocked");
  assert.match(blocked.reason, /only stage -> main/i);
  assert.equal(calls.some(([kind]) => kind === "merge"), false);
});

test("replays an already merged stage-to-main promotion without another merge call", async () => {
  const { GithubTracker } = await import("../src/github.js");
  const calls: unknown[] = [];
  const fake = mergeInspectionGithub(calls, {
    pull: promotionPullRequest({
      state: "closed",
      merged: true,
      merged_at: "2026-08-03T12:00:00Z",
      merge_commit_sha: "main92",
    }),
  });
  const tracker = new GithubTracker(fake as never);

  assert.deepEqual(await tracker.mergePromotionPullRequest(92), {
    kind: "already-merged",
    pullRequestNumber: 92,
    url: "https://github.com/acme/service/pull/92",
    mergeSha: "main92",
  });
  assert.equal(calls.some(([kind]) => kind === "merge"), false);
});

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 91,
    node_id: "PR_node_91",
    html_url: "https://github.com/acme/service/pull/91",
    title: "Fix #91: Health",
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: null,
    head: { ref: "opencode/issue-91", sha: "feature91" },
    base: { ref: "stage", sha: "stage0" },
    ...overrides,
  };
}

function promotionPullRequest(overrides: Record<string, unknown> = {}) {
  return pullRequest({
    number: 92,
    node_id: "PR_node_92",
    html_url: "https://github.com/acme/service/pull/92",
    title: "Release 91",
    head: { ref: "stage", sha: "stage91" },
    base: { ref: "main", sha: "main90" },
    ...overrides,
  });
}

function mergeInspectionGithub(
  calls: unknown[],
  options: {
    pull: ReturnType<typeof pullRequest>;
    checks?: unknown[];
    reviews?: unknown[];
    merge?: { merged: boolean; sha: string; message: string };
    branches?: { stage: string; main: string };
    listedPulls?: unknown[];
  },
) {
  return {
    rest: {
      checks: {
        listForRef: async (request: unknown) => {
          calls.push(["checks", request]);
          return { data: { check_runs: options.checks ?? [] } };
        },
      },
      repos: {
        getBranch: async (request: { branch: "stage" | "main" }) => {
          calls.push(["branch", request]);
          return { data: { commit: { sha: options.branches?.[request.branch] ?? request.branch } } };
        },
      },
      pulls: {
        get: async (request: unknown) => {
          calls.push(["get", request]);
          return { data: options.pull };
        },
        list: async (request: unknown) => {
          calls.push(["list", request]);
          return { data: options.listedPulls ?? [] };
        },
        listReviews: async (request: unknown) => {
          calls.push(["reviews", request]);
          return { data: options.reviews ?? [] };
        },
        merge: async (request: unknown) => {
          calls.push(["merge", request]);
          return { data: options.merge ?? { merged: false, sha: "", message: "blocked" } };
        },
      },
    },
  };
}
