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
  taskCompletionEvents,
  terminalSessionIdleEvent,
  sessionSnapshotEvents,
} from "../lib/native-events.mjs";

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
