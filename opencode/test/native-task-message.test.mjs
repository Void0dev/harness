import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { materializeCommandOutcome, materializeTaskMessages } from "../lib/native-task-message.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-native-message-"));
  const dbPath = path.join(directory, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, directory TEXT NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  return { db, dbPath, directory };
}

function insertSession(db, id, title, directory, parentID = null) {
  db.prepare("INSERT INTO session (id, parent_id, title, directory, time_updated) VALUES (?, ?, ?, ?, ?)")
    .run(id, parentID, title, directory, 1_000);
}

function insertMessage(db, { id, sessionId, createdAt, data, parts }) {
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionId, createdAt, createdAt, JSON.stringify(data));
  parts.forEach((part, index) => {
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`prt_fixture_${id}_${index}`, id, sessionId, createdAt + index, createdAt + index, JSON.stringify(part));
  });
}

test("materializes the child final answer and native diffs into the parent turn exactly once", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    const child = "ses_worker_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertSession(db, child, "GitHub Issue #57 worker", "/runs/issue-57", parent);
    insertMessage(db, {
      id: "msg_parent_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 }, agent: "chat", model: { providerID: "void", modelID: "gpt-5.5" }, summary: { diffs: [] } },
      parts: [{ type: "text", text: "Issue #57: /issue Исправь вход" }],
    });
    insertMessage(db, {
      id: "msg_progress_12345678", sessionId: parent, createdAt: 1_500,
      data: { role: "user", time: { created: 1_500 }, agent: "chat", model: { providerID: "void", modelID: "gpt-5.5" } },
      parts: [{ type: "text", text: "Issue #57: пишу код и запускаю необходимые проверки…" }],
    });
    const diffs = [{ file: "src/login.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" }];
    insertMessage(db, {
      id: "msg_child_user_12345678", sessionId: child, createdAt: 2_000,
      data: { role: "user", time: { created: 2_000 }, summary: { diffs } },
      parts: [{ type: "text", text: "worker prompt" }],
    });
    insertMessage(db, {
      id: "msg_child_final_12345678", sessionId: child, createdAt: 3_000,
      data: { role: "assistant", parentID: "msg_child_user_12345678", modelID: "gpt-5.5", providerID: "void", time: { created: 3_000, completed: 5_000 }, finish: "stop" },
      parts: [{ type: "text", text: "Исправил вход.\n\n<promise>COMPLETE</promise>", time: { start: 3_500, end: 4_500 } }],
    });

    const task = {
      schemaVersion: 1, issueNumber: 57, title: "Исправь вход", status: "finished",
      stages: ["accepted", "studying", "coding", "testing", "publishing"],
      workerSessionPath: "/cnVucw/session/ses_worker_12345678",
      prUrl: "https://github.com/acme/repo/pull/9",
      modelId: "gpt-5.5", generationStartedAt: new Date(3_000).toISOString(), generationCompletedAt: new Date(5_000).toISOString(),
      updatedAt: new Date(6_000).toISOString(),
    };

    assert.deepEqual(materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [task], projectDirectory: "/workspace" }), { changed: true });
    assert.deepEqual(materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [task], projectDirectory: "/workspace" }), { changed: false });

    const parentData = JSON.parse(db.prepare("SELECT data FROM message WHERE id = ?").get("msg_parent_12345678").data);
    assert.deepEqual(parentData.summary.diffs, diffs);
    const parentText = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get("msg_parent_12345678").data).text;
    assert.equal(parentText, "/issue Исправь вход\n\n<!-- opencode-harness-issue: 57 -->");
    const progressData = JSON.parse(db.prepare("SELECT data FROM message WHERE id = ?").get("msg_progress_12345678").data);
    assert.equal(progressData.role, "assistant");
    assert.equal(progressData.parentID, "msg_parent_12345678");
    const projected = db.prepare("SELECT id, data FROM message WHERE session_id = ? AND id LIKE 'msg_harness_%'").all(parent);
    const orderedProjection = db.prepare("SELECT id, data FROM message WHERE session_id = ? AND id LIKE ?").all(parent, "msg_parent_12345678_harness_task_%");
    assert.equal(projected.length, 0);
    assert.equal(orderedProjection.length, 1);
    const assistant = JSON.parse(orderedProjection[0].data);
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.parentID, "msg_parent_12345678");
    assert.equal(assistant.modelID, "gpt-5.5");
    const text = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get(orderedProjection[0].id).data).text;
    assert.match(text, /^Исправил вход\./);
    assert.doesNotMatch(text, /<promise>/);
    assert.match(text, /История изменений/);
    assert.match(text, /Pull Request/);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates a legacy harness result to an id ordered directly after its user anchor", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, {
      id: "msg_anchor_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 }, summary: { diffs: [] } },
      parts: [{ type: "text", text: "/issue fix\n\n<!-- opencode-harness-issue: 7 -->" }],
    });
    insertMessage(db, {
      id: "msg_harness_legacy_result", sessionId: parent, createdAt: 2_000,
      data: { role: "assistant", parentID: "msg_anchor_12345678", time: { created: 2_000, completed: 2_000 }, finish: "stop" },
      parts: [{ type: "text", text: "old result" }],
    });
    const task = {
      schemaVersion: 1, issueNumber: 7, title: "fix", status: "failed", stages: ["accepted"],
      question: "failed", updatedAt: new Date(3_000).toISOString(),
    };

    materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [task], projectDirectory: "/workspace" });

    assert.equal(db.prepare("SELECT COUNT(*) count FROM message WHERE id = ?").get("msg_harness_legacy_result").count, 0);
    const ordered = db.prepare("SELECT id, data FROM message WHERE id LIKE ?").get("msg_anchor_12345678_harness_task_%");
    assert.ok(ordered);
    assert.equal(JSON.parse(ordered.data).parentID, "msg_anchor_12345678");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("uses the latest accepted retry as the native result anchor", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, { id: "msg_issue_12345678", sessionId: parent, createdAt: 1_000, data: { role: "user", time: { created: 1_000 } }, parts: [{ type: "text", text: "Issue #3: /issue Почини" }] });
    insertMessage(db, { id: "msg_retry_12345678", sessionId: parent, createdAt: 2_000, data: { role: "user", time: { created: 2_000 } }, parts: [{ type: "text", text: "Повторный запуск Issue #3 поставлен в очередь.\n\n/retry Учти тест" }] });
    insertMessage(db, { id: "msg_busy_12345678", sessionId: parent, createdAt: 2_500, data: { role: "user", time: { created: 2_500 } }, parts: [{ type: "text", text: "Нельзя создать новый Issue: Issue #3 уже выполняется.\n\n/issue Ещё одна задача" }] });
    const task = { schemaVersion: 1, issueNumber: 3, title: "Почини", status: "failed", stages: ["accepted"], question: "Сетевая ошибка", modelId: "gpt-5.5", generationStartedAt: new Date(3_000).toISOString(), generationCompletedAt: new Date(4_000).toISOString(), updatedAt: new Date(4_000).toISOString() };

    materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [task], projectDirectory: "/workspace" });
    const projected = db.prepare("SELECT data FROM message WHERE session_id = ? AND id LIKE '%_harness_task_%'").all(parent)
      .map((row) => JSON.parse(row.data)).find((message) => message.parentID === "msg_retry_12345678");
    assert.equal(projected.parentID, "msg_retry_12345678");
    const busyText = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get("msg_busy_12345678").data).text;
    assert.equal(busyText, "/issue Ещё одна задача");
    const busyReply = db.prepare("SELECT data FROM message WHERE session_id = ? AND id LIKE '%_harness_command_%'").all(parent)
      .map((row) => JSON.parse(row.data)).find((message) => message.parentID === "msg_busy_12345678");
    assert.equal(busyReply.role, "assistant");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("removes obsolete progress from the original command after retry finishes", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    const child = "ses_worker_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertSession(db, child, "GitHub Issue #9 worker", "/runs/issue-9", parent);
    insertMessage(db, { id: "msg_issue_12345678", sessionId: parent, createdAt: 1_000, data: { role: "user", time: { created: 1_000 } }, parts: [{ type: "text", text: "/issue fix\n\n<!-- opencode-harness-issue: 9 -->" }] });
    insertMessage(db, { id: "msg_issue_12345678_harness_task_old", sessionId: parent, createdAt: 1_100, data: { role: "assistant", parentID: "msg_issue_12345678", time: { created: 1_100 } }, parts: [{ type: "text", text: "Изучаю код…" }] });
    insertMessage(db, { id: "msg_generated_progress_12345678", sessionId: parent, createdAt: 1_200, data: { role: "assistant", parentID: "msg_issue_12345678", time: { created: 1_200, completed: 1_250 }, finish: "stop" }, parts: [{ type: "text", text: "Изучаю код…" }] });
    insertMessage(db, { id: "msg_retry_12345678", sessionId: parent, createdAt: 2_000, data: { role: "user", time: { created: 2_000 } }, parts: [{ type: "text", text: "/retry\n\n<!-- opencode-harness-issue: 9 -->" }] });
    insertMessage(db, { id: "msg_child_user_12345678", sessionId: child, createdAt: 3_000, data: { role: "user", time: { created: 3_000 }, summary: { diffs: [] } }, parts: [{ type: "text", text: "worker prompt" }] });
    insertMessage(db, { id: "msg_child_final_12345678", sessionId: child, createdAt: 4_000, data: { role: "assistant", parentID: "msg_child_user_12345678", modelID: "gpt-5.5", providerID: "void", time: { created: 4_000, completed: 5_000 }, finish: "stop" }, parts: [{ type: "text", text: "Готово." }] });

    materializeTaskMessages({
      dbPath,
      parentSessionId: parent,
      projectDirectory: "/workspace",
      tasks: [{
        schemaVersion: 1, issueNumber: 9, title: "fix", status: "finished",
        stages: ["accepted", "studying", "coding", "testing", "publishing"],
        workerSessionPath: "/cnVucw/session/ses_worker_12345678",
        prUrl: "https://github.com/acme/repo/pull/10",
        updatedAt: new Date(6_000).toISOString(),
      }],
    });

    assert.equal(db.prepare("SELECT COUNT(*) count FROM message WHERE id = ?").get("msg_issue_12345678_harness_task_old").count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM message WHERE id = ?").get("msg_generated_progress_12345678").count, 0);
    const final = db.prepare("SELECT data FROM message WHERE id LIKE ?").get("msg_retry_12345678_harness_task_%");
    assert.equal(JSON.parse(final.data).finish, "stop");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps the exact user command and adds a native assistant reply for a busy rejection", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, {
      id: "msg_user_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 }, agent: "chat", model: { providerID: "void", modelID: "gpt-5.5" } },
      parts: [{ type: "text", text: "/issue ещё одна задача" }],
    });

    assert.deepEqual(materializeCommandOutcome({
      dbPath,
      parentSessionId: parent,
      messageID: "msg_user_12345678",
      commandText: "/issue ещё одна задача",
      outcome: { status: "busy", issueNumber: 9 },
      projectDirectory: "/workspace",
      updatedAt: 2_000,
    }), { changed: true });

    const userText = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get("msg_user_12345678").data).text;
    assert.equal(userText, "/issue ещё одна задача");
    const reply = db.prepare("SELECT m.data, p.data part_data FROM message m JOIN part p ON p.message_id=m.id WHERE m.id LIKE ?").get("msg_user_12345678_harness_command_%");
    assert.equal(JSON.parse(reply.data).role, "assistant");
    assert.match(JSON.parse(reply.part_data).text, /Issue #9/);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("explains a failed Issue command with its specific safe cause", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, {
      id: "msg_user_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 }, model: { providerID: "void", modelID: "gpt-5.5" } },
      parts: [{ type: "text", text: "/issue исправь вход" }],
    });

    materializeCommandOutcome({
      dbPath,
      parentSessionId: parent,
      messageID: "msg_user_12345678",
      commandText: "/issue исправь вход",
      outcome: { status: "failed", failure: "issue-queue-check-failed" },
      projectDirectory: "/workspace",
      updatedAt: 2_000,
    });

    const reply = db.prepare("SELECT p.data FROM message m JOIN part p ON p.message_id = m.id WHERE m.id LIKE ?")
      .get("msg_user_12345678_harness_command_%");
    assert.match(JSON.parse(reply.data).text, /не удалось проверить очередь задач/i);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps an unknown Harness HTTP status visible in the Issue error", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, {
      id: "msg_user_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 } },
      parts: [{ type: "text", text: "/issue исправь вход" }],
    });

    materializeCommandOutcome({
      dbPath,
      parentSessionId: parent,
      messageID: "msg_user_12345678",
      commandText: "/issue исправь вход",
      outcome: { status: "failed", failure: "harness-http-503" },
      projectDirectory: "/workspace",
      updatedAt: 2_000,
    });

    const reply = db.prepare("SELECT p.data FROM message m JOIN part p ON p.message_id = m.id WHERE m.id LIKE ?")
      .get("msg_user_12345678_harness_command_%");
    assert.match(JSON.parse(reply.data).text, /HTTP 503/);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers a standalone retry acknowledgement as the latest retry command", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, { id: "msg_issue_12345678", sessionId: parent, createdAt: 1_000, data: { role: "user", time: { created: 1_000 } }, parts: [{ type: "text", text: "/issue fix\n\n<!-- opencode-harness-issue: 3 -->" }] });
    insertMessage(db, { id: "msg_retry_ack_12345678", sessionId: parent, createdAt: 2_000, data: { role: "user", time: { created: 2_000 }, model: { providerID: "void", modelID: "gpt-5.5" } }, parts: [{ type: "text", text: "Повторный запуск Issue #3 поставлен в очередь." }] });
    insertMessage(db, { id: "msg_generated_reply_12345678", sessionId: parent, createdAt: 2_100, data: { role: "assistant", parentID: "msg_retry_ack_12345678", time: { created: 2_100, completed: 2_200 }, finish: "stop" }, parts: [{ type: "text", text: "Теперь дождитесь выполнения." }] });
    const task = { schemaVersion: 1, issueNumber: 3, title: "fix", status: "failed", stages: ["accepted"], question: "failed", updatedAt: new Date(3_000).toISOString() };

    materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [task], projectDirectory: "/workspace" });

    const retry = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get("msg_retry_ack_12345678").data).text;
    assert.equal(retry, "/retry\n\n<!-- opencode-harness-issue: 3 -->");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM message WHERE id = ?").get("msg_generated_reply_12345678").count, 0);
    const result = db.prepare("SELECT data FROM message WHERE id LIKE ?").get("msg_retry_ack_12345678_harness_task_%");
    assert.equal(JSON.parse(result.data).parentID, "msg_retry_ack_12345678");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps a rejected command exact and moves its system response to the assistant side without a task", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, {
      id: "msg_busy_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 }, agent: "chat", model: { providerID: "void", modelID: "gpt-5.5" } },
      parts: [{ type: "text", text: "Harness временно недоступен.\n\n/issue Исправь вход" }],
    });
    insertMessage(db, {
      id: "msg_old_error_12345678", sessionId: parent, createdAt: 1_500,
      data: { role: "user", time: { created: 1_500 }, agent: "chat", model: { providerID: "void", modelID: "gpt-5.5" } },
      parts: [{ type: "text", text: "Нельзя создать новый Issue: другая задача уже выполняется." }],
    });

    assert.deepEqual(materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [], projectDirectory: "/workspace" }), { changed: true });
    assert.deepEqual(materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [], projectDirectory: "/workspace" }), { changed: false });
    const userText = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get("msg_busy_12345678").data).text;
    assert.equal(userText, "/issue Исправь вход");
    const reply = db.prepare("SELECT data FROM message WHERE id LIKE '%_harness_command_%'").all()
      .map((row) => JSON.parse(row.data))[0];
    assert.equal(reply.role, "assistant");
    assert.equal(reply.parentID, "msg_busy_12345678");
    const oldError = JSON.parse(db.prepare("SELECT data FROM message WHERE id = ?").get("msg_old_error_12345678").data);
    assert.equal(oldError.role, "assistant");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("removes a generated reply whose parent was migrated from a system error to assistant", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, {
      id: "msg_real_user_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 }, agent: "chat", model: { providerID: "void", modelID: "gpt-5.5" } },
      parts: [{ type: "text", text: "Какого цвета фон?" }],
    });
    insertMessage(db, {
      id: "msg_system_error_12345678", sessionId: parent, createdAt: 2_000,
      data: {
        parentID: "msg_real_user_12345678", role: "assistant", time: { created: 2_000, completed: 2_000 },
        finish: "stop", modelID: "gpt-5.5", providerID: "void",
      },
      parts: [{ type: "text", text: "Нельзя создать новый Issue: Issue #1 уже выполняется." }],
    });
    insertMessage(db, {
      id: "msg_invalid_reply_12345678", sessionId: parent, createdAt: 3_000,
      data: {
        parentID: "msg_system_error_12345678", role: "assistant", time: { created: 3_000, completed: 4_000 },
        finish: "stop", modelID: "gpt-5.5", providerID: "void",
      },
      parts: [{ type: "text", text: "Похоже, Issue #1 уже выполняется." }],
    });

    assert.deepEqual(materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [], projectDirectory: "/workspace" }), { changed: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM message WHERE id = ?").get("msg_invalid_reply_12345678").count, 0);
    assert.deepEqual(materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [], projectDirectory: "/workspace" }), { changed: false });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps only one native system reply when an old command generated a duplicate", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertMessage(db, { id: "msg_user_12345678", sessionId: parent, createdAt: 1_000, data: { role: "user", time: { created: 1_000 } }, parts: [{ type: "text", text: "/issue ещё одна задача" }] });
    const text = "Нельзя создать новый Issue: Issue #9 уже выполняется или ожидает выполнения. Дождитесь его завершения.";
    insertMessage(db, { id: "msg_user_12345678_harness_command_keep", sessionId: parent, createdAt: 1_100, data: { role: "assistant", parentID: "msg_user_12345678", time: { created: 1_100, completed: 1_100 }, finish: "stop" }, parts: [{ type: "text", text }] });
    insertMessage(db, { id: "msg_generated_duplicate_12345678", sessionId: parent, createdAt: 1_200, data: { role: "assistant", parentID: "msg_user_12345678", time: { created: 1_200, completed: 1_300 }, finish: "stop" }, parts: [{ type: "text", text }] });

    assert.deepEqual(materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [], projectDirectory: "/workspace" }), { changed: true });
    const remaining = db.prepare("SELECT COUNT(*) count FROM message WHERE session_id = ? AND json_extract(data, '$.parentID') = ?").get(parent, "msg_user_12345678").count;
    assert.equal(remaining, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM message WHERE id = ?").get("msg_user_12345678_harness_command_keep").count, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers a legacy command in place without appending an artificial user turn", () => {
  const { db, dbPath, directory } = fixture();
  try {
    const parent = "ses_parent_12345678";
    const child = "ses_worker_12345678";
    insertSession(db, parent, "Project chat", "/workspace");
    insertSession(db, child, "Issue #9: Красный фон", "/runs/issue-9", parent);
    insertMessage(db, {
      id: "msg_legacy_12345678", sessionId: parent, createdAt: 1_000,
      data: { role: "user", time: { created: 1_000 }, agent: "chat", model: { providerID: "void", modelID: "gpt-5.5" } },
      parts: [{ type: "text", text: "Issue #9 принят. Изучаю код и готовлю изменения…" }],
    });
    insertMessage(db, {
      id: "msg_child_user_87654321", sessionId: child, createdAt: 2_000,
      data: { role: "user", time: { created: 2_000 }, summary: { diffs: [] } },
      parts: [{ type: "text", text: "Title:\nПоменяй фон на красный\n\nBody:\nПоменяй фон на красный" }],
    });
    insertMessage(db, {
      id: "msg_child_final_87654321", sessionId: child, createdAt: 3_000,
      data: { role: "assistant", parentID: "msg_child_user_87654321", modelID: "gpt-5.5", providerID: "void", time: { created: 3_000, completed: 4_000 }, finish: "stop" },
      parts: [{ type: "text", text: "Готово. <promise>COMPLETE</promise>" }],
    });
    const task = { schemaVersion: 1, issueNumber: 9, title: "Issue #9", status: "finished", stages: ["accepted", "coding", "publishing"], updatedAt: new Date(5_000).toISOString() };

    materializeTaskMessages({ dbPath, parentSessionId: parent, tasks: [task], projectDirectory: "/workspace" });
    const command = JSON.parse(db.prepare("SELECT data FROM part WHERE message_id = ?").get("msg_legacy_12345678").data).text;
    assert.equal(command, "/issue Поменяй фон на красный\n\n<!-- opencode-harness-issue: 9 -->");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM message WHERE id LIKE 'msg_harness_command_user_%'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
