import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRefreshCoordinator, sessionIdFromPath, taskTimestamp, visibleCommandText } from "../ui/task-card.mjs";

test("extracts only a valid OpenCode session ID from the route", () => {
  assert.equal(sessionIdFromPath("/project/session/ses_parent_12345678"), "ses_parent_12345678");
  assert.equal(sessionIdFromPath("/project/session"), undefined);
});

test("shows exactly the slash command entered by the user", () => {
  assert.equal(visibleCommandText("Issue #57: /issue Исправь вход"), "/issue Исправь вход");
  assert.equal(visibleCommandText("Повторный запуск Issue #57 поставлен в очередь.\n\n/retry Учти тест"), "/retry Учти тест");
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
