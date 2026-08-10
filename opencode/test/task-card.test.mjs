import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  appendBackgroundSessionTab,
  createBackgroundTabCoordinator,
  createRefreshCoordinator,
  sessionIdFromPath,
  synchronizeGitHubIssueTabs,
  taskTimestamp,
  visibleCommandText,
} from "../ui/task-card.mjs";

test("extracts only a valid OpenCode session ID from the route", () => {
  assert.equal(sessionIdFromPath("/project/session/ses_parent_12345678"), "ses_parent_12345678");
  assert.equal(sessionIdFromPath("/project/session"), undefined);
});

test("shows exactly the slash command entered by the user", () => {
  assert.equal(visibleCommandText("Issue #57: /issue Исправь вход"), "/issue Исправь вход");
  assert.equal(visibleCommandText("Повторный запуск Issue #57 поставлен в очередь.\n\n/retry Учти тест"), "/retry Учти тест");
  assert.equal(visibleCommandText("/merge stage #57"), "/merge stage #57");
  assert.equal(visibleCommandText("/merge prod"), "/merge prod");
  assert.equal(visibleCommandText("Обычное сообщение"), undefined);
});

test("formats the user timestamp without model metadata", () => {
  assert.equal(taskTimestamp("2026-07-28T14:31:07.250Z", "ru-RU", "UTC"), "14:31");
});

test("does not overlap task refreshes and aborts stale routes", () => {
  const coordinator = createRefreshCoordinator();
  const first = coordinator.begin("ses_parent_12345678");
  assert.equal(coordinator.begin("ses_parent_12345678"), undefined);
  const second = coordinator.begin("ses_other_12345678");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.isCurrent(), true);
});

test("never reloads the whole page while task state changes", () => {
  const source = fs.readFileSync(new URL("../ui/task-card.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /location\.reload\s*\(/);
});

test("adds a GitHub parent chat to the same persisted OpenCode tab list without changing the active tab", () => {
  const current = JSON.stringify([{ type: "session", server: "http://localhost:4096", sessionId: "ses_current_12345678" }]);
  assert.deepEqual(JSON.parse(appendBackgroundSessionTab(current, "ses_github_12345678")), [
    { type: "session", server: "http://localhost:4096", sessionId: "ses_current_12345678" },
    { type: "session", server: "http://localhost:4096", sessionId: "ses_github_12345678" },
  ]);
  assert.equal(appendBackgroundSessionTab(current, "ses_current_12345678"), current);
});

test("first GitHub Issue sync baselines history without changing existing tabs", () => {
  const current = JSON.stringify([
    { type: "session", server: "http://localhost:4096", sessionId: "ses_current_12345678" },
    { type: "session", server: "http://localhost:4096", sessionId: "ses_github_a_12345678" },
  ]);
  const sessions = [
    { id: "ses_github_a_12345678", title: "GitHub Issue #29: first", time: { created: 200 } },
    { id: "ses_github_b_12345678", title: "GitHub Issue #30: second", time: { created: 201 } },
  ];
  const result = synchronizeGitHubIssueTabs(current, null, "owner/repository", sessions);

  assert.equal(result.tabs, current);
  assert.deepEqual(JSON.parse(result.memory), {
    version: 1,
    repositories: [{ scope: "owner/repository", issues: [29, 30] }],
  });
});

test("ignores an invalid server session response without changing browser state", () => {
  const current = JSON.stringify([{ type: "session", server: "http://localhost:4096", sessionId: "ses_current_12345678" }]);
  const memory = JSON.stringify({ version: 1, repositories: [{ scope: "owner/repository", issues: [27] }] });

  assert.deepEqual(synchronizeGitHubIssueTabs(current, memory, "owner/repository", null), {
    tabs: current,
    memory,
  });
});

test("adds only an Issue discovered after the browser baseline", () => {
  const current = JSON.stringify([{ type: "session", server: "http://localhost:4096", sessionId: "ses_current_12345678" }]);
  const memory = JSON.stringify({ version: 1, repositories: [{ scope: "owner/repository", issues: [27] }] });
  const sessions = [
    { id: "ses_github_old_12345678", title: "GitHub Issue #27: created earlier", time: { created: 1 } },
    { id: "ses_github_new_12345678", title: "GitHub Issue #28: created while away", time: { created: 2 } },
  ];
  const result = synchronizeGitHubIssueTabs(current, memory, "owner/repository", sessions);

  assert.deepEqual(JSON.parse(result.tabs), [
    { type: "session", server: "http://localhost:4096", sessionId: "ses_current_12345678" },
    { type: "session", server: "http://localhost:4096", sessionId: "ses_github_new_12345678" },
  ]);
  assert.deepEqual(JSON.parse(result.memory).repositories[0].issues, [27, 28]);
});

test("does not restore an Issue tab after the user closes it and reloads the application", () => {
  const current = JSON.stringify([{ type: "session", server: "http://localhost:4096", sessionId: "ses_regular_12345678" }]);
  const memory = JSON.stringify({ version: 1, repositories: [{ scope: "owner/repository", issues: [35] }] });
  const sessions = [
    { id: "ses_issue_35_12345678", title: "GitHub Issue #35: background", time: { created: 100 } },
  ];

  assert.equal(synchronizeGitHubIssueTabs(current, memory, "owner/repository", sessions).tabs, current);
});

test("keeps Issue memory independent for every repository", () => {
  const current = JSON.stringify([{ type: "session", server: "http://localhost:4096", sessionId: "ses_regular_12345678" }]);
  const memory = JSON.stringify({ version: 1, repositories: [{ scope: "owner/first", issues: [35] }] });
  const sessions = [{ id: "ses_issue_35_12345678", title: "GitHub Issue #35: background", time: { created: 100 } }];

  const result = synchronizeGitHubIssueTabs(current, memory, "owner/second", sessions);
  assert.equal(result.tabs, current);
  assert.deepEqual(JSON.parse(result.memory).repositories, [
    { scope: "owner/first", issues: [35] },
    { scope: "owner/second", issues: [35] },
  ]);
});

test("adds only the oldest canonical session when a newly discovered Issue has legacy duplicates", () => {
  const current = JSON.stringify([{ type: "session", server: "http://localhost:4096", sessionId: "ses_regular_12345678" }]);
  const memory = JSON.stringify({ version: 1, repositories: [{ scope: "owner/repository", issues: [] }] });
  const sessions = [
    { id: "ses_issue_new_12345678", title: "GitHub Issue #35: duplicate", time: { created: 200 } },
    { id: "ses_issue_old_12345678", title: "GitHub Issue #35: canonical", time: { created: 100 } },
  ];

  const result = synchronizeGitHubIssueTabs(current, memory, "owner/repository", sessions);
  assert.deepEqual(JSON.parse(result.tabs), [
    { type: "session", server: "http://localhost:4096", sessionId: "ses_regular_12345678" },
    { type: "session", server: "http://localhost:4096", sessionId: "ses_issue_old_12345678" },
  ]);
});

test("synchronizes unchanged GitHub sessions only once and wakes up for a genuinely new chat", () => {
  const coordinator = createBackgroundTabCoordinator();
  const first = [{ id: "ses_issue_34_12345678", title: "GitHub Issue #34: first", time: { created: 100 } }];
  const same = [{ id: "ses_issue_34_12345678", title: "GitHub Issue #34: first", time: { created: 100 } }];
  const withNew = [
    ...same,
    { id: "ses_issue_36_12345678", title: "GitHub Issue #36: newest", time: { created: 200 } },
  ];

  assert.equal(coordinator.shouldSynchronize(first), true);
  assert.equal(coordinator.shouldSynchronize(same), false);
  assert.equal(coordinator.shouldSynchronize(withNew), true);
  assert.equal(coordinator.shouldSynchronize(withNew), false);
});

test("stores a newly-created external chat tab without reloading the user's current page", () => {
  const source = fs.readFileSync(new URL("../ui/task-card.mjs", import.meta.url), "utf8");
  const serverSource = fs.readFileSync(new URL("../web-entry.mjs", import.meta.url), "utf8");
  assert.match(source, /appendBackgroundSessionTab/);
  assert.match(source, /fetch\("\/__harness\/api\/github-parent-sessions"/);
  assert.match(source, /localStorage\.setItem\(OPEN_CODE_TABS_STORAGE_KEY, next\)/);
  assert.match(source, /new StorageEvent\("storage"/);
  assert.match(serverSource, /scope:\s*repositoryScope/);
  assert.doesNotMatch(source, /iframe|projectDirectoryFromPath/);
  assert.doesNotMatch(source, /location\.reload\s*\(/);
});

test("does not add a duplicate Harness-only session strip", () => {
  const source = fs.readFileSync(new URL("../ui/task-card.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /harness-github-issue-tabs/);
});
