import assert from "node:assert/strict";
import test from "node:test";
import { projectSessionMetadata } from "../lib/session-metadata.mjs";

test("projects exact user and aggregated assistant timing from OpenCode messages", () => {
  assert.deepEqual(projectSessionMetadata([
    {
      info: { id: "msg_user_12345678", role: "user", time: { created: 1_000 } },
      parts: [{ type: "text", text: "Issue #57: /issue Fix login" }],
    },
    { info: { id: "msg_a_12345678", role: "assistant", parentID: "msg_user_12345678", modelID: "gpt-5.5", time: { created: 1_100, completed: 20_000 } } },
    { info: { id: "msg_b_12345678", role: "assistant", parentID: "msg_user_12345678", modelID: "gpt-5.5", time: { created: 20_100, completed: 102_000 } } },
  ]), {
    users: [{
      messageId: "msg_user_12345678",
      createdAt: "1970-01-01T00:00:01.000Z",
      issueNumber: 57,
    }],
    assistants: [{
      parentMessageId: "msg_user_12345678",
      modelId: "gpt-5.5",
      generationStartedAt: "1970-01-01T00:00:01.100Z",
      generationCompletedAt: "1970-01-01T00:01:42.000Z",
    }],
  });
});

test("does not invent an Issue anchor for an ordinary user message", () => {
  assert.deepEqual(projectSessionMetadata([{
    info: { id: "msg_user_12345678", role: "user", time: { created: 1_000 } },
    parts: [{ type: "text", text: "Давай обсудим Issue #57" }],
  }]).users, [{ messageId: "msg_user_12345678", createdAt: "1970-01-01T00:00:01.000Z" }]);
});

test("anchors an old chat task to its latest accepted retry instead of any visible progress row", () => {
  const users = projectSessionMetadata([
    {
      info: { id: "msg_issue_12345678", role: "user", time: { created: 1_000 } },
      parts: [{ type: "text", text: "Issue #3 принят. Изучаю код и готовлю изменения…" }],
    },
    {
      info: { id: "msg_error_12345678", role: "user", time: { created: 2_000 } },
      parts: [{ type: "text", text: "Issue #3: выполнение остановилось с ошибкой. Нужна проверка разработчика." }],
    },
    {
      info: { id: "msg_retry_12345678", role: "user", time: { created: 3_000 } },
      parts: [{ type: "text", text: "Повторный запуск Issue #3 поставлен в очередь." }],
    },
  ]).users;

  assert.deepEqual(users, [
    { messageId: "msg_issue_12345678", createdAt: "1970-01-01T00:00:01.000Z" },
    { messageId: "msg_error_12345678", createdAt: "1970-01-01T00:00:02.000Z" },
    { messageId: "msg_retry_12345678", createdAt: "1970-01-01T00:00:03.000Z", issueNumber: 3 },
  ]);
});

test("keeps a persisted slash command as the canonical anchor instead of later progress", () => {
  const users = projectSessionMetadata([
    {
      info: { id: "msg_command_12345678", role: "user", time: { created: 1_000 } },
      parts: [{ type: "text", text: "Issue #8: /issue Исправь форму" }],
    },
    {
      info: { id: "msg_progress_12345678", role: "user", time: { created: 2_000 } },
      parts: [{ type: "text", text: "Issue #8: пишу код и запускаю необходимые проверки…" }],
    },
  ]).users;

  assert.equal(users[0].issueNumber, 8);
  assert.equal(users[1].issueNumber, undefined);
});
