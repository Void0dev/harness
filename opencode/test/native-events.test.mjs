import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  captureSessionMessageIds,
  createNativeEventHub,
  createSseForwarder,
  encodeNativeEvent,
  sessionCreatedEvent,
  findGitHubIssueParentSession,
  listGitHubIssueParentSessions,
  taskCompletionEvents,
  terminalSessionIdleEvent,
  sessionSnapshotEvents,
} from "../lib/native-events.mjs";

test("reuses the oldest existing parent session for the same GitHub Issue", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-native-session-reuse-"));
  const dbPath = path.join(directory, "opencode.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER)");
    const insert = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)");
    insert.run("ses_first_12345678", null, "GitHub Issue #57: Fix login", "/workspace", 1_000);
    insert.run("ses_duplicate_12345678", null, "GitHub Issue #57: Fix login", "/workspace", 2_000);
    insert.run("ses_child_12345678", "ses_first_12345678", "GitHub Issue #57 worker", "/workspace", 500);
    insert.run("ses_other_12345678", null, "GitHub Issue #58: Fix logout", "/workspace", 100);

    assert.equal(findGitHubIssueParentSession(dbPath, 57, "/workspace"), "ses_first_12345678");
    assert.equal(findGitHubIssueParentSession(dbPath, 59, "/workspace"), undefined);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("lists every GitHub parent session without the OpenCode API page limit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-native-parent-list-"));
  const dbPath = path.join(directory, "opencode.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)");
    const insert = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 1; index <= 120; index += 1) {
      insert.run(`ses_issue_${String(index).padStart(8, "0")}`, null, `GitHub Issue #34: copy ${index}`, "/workspace", index, index);
    }
    insert.run("ses_issue_36_12345678", null, "GitHub Issue #36: newest task", "/workspace", 121, 121);
    insert.run("ses_regular_12345678", null, "Regular chat", "/workspace", 122, 122);

    const sessions = listGitHubIssueParentSessions(dbPath, "/workspace");
    assert.equal(sessions.length, 121);
    assert.equal(sessions.at(-1).title, "GitHub Issue #36: newest task");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("projects a newly created session as the event used by the session switcher", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-native-session-event-"));
  const dbPath = path.join(directory, "opencode.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT,
        path TEXT, title TEXT, version TEXT, cost REAL, tokens_input INTEGER,
        tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
        tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER
      );
    `);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ses_test_12345678", "project_123", null, "tidy-eagle", "/workspace", "", "GitHub Issue #57", "1.18.7",
      0, 0, 0, 0, 0, 0, 1_000, 2_000,
    );

    const event = sessionCreatedEvent(dbPath, "ses_test_12345678");
    assert.match(event.id, /^evt_[A-Za-z0-9_-]+$/);
    assert.deepEqual({ type: event.type, properties: event.properties }, {
      type: "session.created",
      properties: {
        sessionID: "ses_test_12345678",
        info: {
          id: "ses_test_12345678", projectID: "project_123", slug: "tidy-eagle", directory: "/workspace",
          path: "", title: "GitHub Issue #57", version: "1.18.7", cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1_000, updated: 2_000 },
        },
      },
    });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("encodes one OpenCode event as a complete SSE frame", () => {
  assert.equal(
    encodeNativeEvent({ type: "message.removed", properties: { sessionID: "ses_test_12345678", messageID: "msg_old_12345678" } }),
    'data: {"type":"message.removed","properties":{"sessionID":"ses_test_12345678","messageID":"msg_old_12345678"}}\n\n',
  );
});

test("marks a server-side command result as terminal for the OpenCode timeline", () => {
  assert.deepEqual(terminalSessionIdleEvent("ses_test_12345678"), {
    type: "session.status",
    properties: { sessionID: "ses_test_12345678", status: { type: "idle" } },
  });
});

test("marks materialized task completion idle after its message and part snapshots", () => {
  const sessionID = "ses_test_12345678";
  const snapshots = [
    { type: "message.updated", properties: { info: { id: "msg_result_12345678" } } },
    { type: "message.part.updated", properties: { part: { id: "prt_result_12345678" } } },
  ];

  assert.deepEqual(taskCompletionEvents(snapshots, sessionID), [
    ...snapshots,
    terminalSessionIdleEvent(sessionID),
  ]);
});

test("keeps an in-progress task in its current session state", () => {
  const snapshots = [{ type: "message.part.updated", properties: { part: { id: "prt_progress_12345678" } } }];

  assert.deepEqual(taskCompletionEvents(snapshots, "ses_test_12345678", false), snapshots);
});

test("wraps injected events for OpenCode's global event stream", () => {
  const writes = [];
  const hub = createNativeEventHub();
  hub.subscribe((value) => writes.push(value), {
    pathname: "/global/event",
    directory: "/home/opencode/workspace",
  });

  hub.publish([{ type: "message.updated", properties: { info: { id: "msg_result_12345678" } } }]);

  assert.deepEqual(writes, [
    'data: {"directory":"/home/opencode/workspace","payload":{"type":"message.updated","properties":{"info":{"id":"msg_result_12345678"}}}}\n\n',
  ]);
});

test("keeps injected events unwrapped for OpenCode's project event stream", () => {
  const writes = [];
  const hub = createNativeEventHub();
  hub.subscribe((value) => writes.push(value), {
    pathname: "/event",
    directory: "/home/opencode/workspace",
  });

  hub.publish([{ type: "message.updated", properties: {} }]);

  assert.deepEqual(writes, ['data: {"type":"message.updated","properties":{}}\n\n']);
});

test("forwards upstream SSE only at frame boundaries", () => {
  const writes = [];
  const forwarder = createSseForwarder((value) => writes.push(value));
  forwarder.push(Buffer.from('data: {"type":"message.'));
  assert.deepEqual(writes, []);
  forwarder.push(Buffer.from('updated"}\n\ndata: next'));
  assert.deepEqual(writes, ['data: {"type":"message.updated"}\n\n']);
  forwarder.end();
  assert.deepEqual(writes, ['data: {"type":"message.updated"}\n\n', "data: next"]);
});

test("projects only removals and changed native messages after external database changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-native-events-"));
  const dbPath = path.join(directory, "opencode.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const sessionID = "ses_test_12345678";
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg_old_12345678", sessionID, 1, 1, JSON.stringify({ role: "assistant", parentID: "msg_user_12345678" }));
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg_unchanged_12345678", sessionID, 2, 2, JSON.stringify({ role: "user", time: { created: 2 } }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("prt_unchanged_12345678", "msg_unchanged_12345678", sessionID, 2, 2, JSON.stringify({ type: "text", text: "Не менять" }));
    const before = captureSessionMessageIds(dbPath, sessionID);
    db.prepare("DELETE FROM message WHERE id = ?").run("msg_old_12345678");
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg_user_12345678_harness_task_result", sessionID, 2, 2, JSON.stringify({ role: "assistant", parentID: "msg_user_12345678", time: { created: 2, completed: 3 }, finish: "stop" }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("prt_result_12345678", "msg_user_12345678_harness_task_result", sessionID, 2, 2, JSON.stringify({ type: "text", text: "Готово" }));

    const events = sessionSnapshotEvents(dbPath, sessionID, before);
    assert.deepEqual(events[0], { type: "message.removed", properties: { sessionID, messageID: "msg_old_12345678" } });
    const message = events.find((event) => event.type === "message.updated");
    assert.equal(message.properties.info.id, "msg_user_12345678_harness_task_result");
    assert.equal(message.properties.info.sessionID, sessionID);
    assert.equal(events.some((event) => event.properties.info?.id === "msg_unchanged_12345678"), false);
    const part = events.find((event) => event.type === "message.part.updated");
    assert.equal(part.properties.part.messageID, "msg_user_12345678_harness_task_result");
    assert.equal(part.properties.part.text, "Готово");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
