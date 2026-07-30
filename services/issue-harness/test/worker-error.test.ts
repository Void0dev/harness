import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeSessionError } from "../src/opencode-client.js";
import { workerFailureQuestion } from "../src/worker-error.js";

test("explains invalid model credentials instead of blaming the coding task", () => {
  const message = workerFailureQuestion(new OpenCodeSessionError("model_authentication"));
  assert.match(message, /VOID_AI_API_KEY/);
  assert.match(message, /отклонила|аннулирован|недействителен/i);
  assert.doesNotMatch(message, /^Рабочая сессия остановилась из-за технической ошибки/);
});

test("keeps a bounded retry instruction for an unknown technical failure", () => {
  assert.match(workerFailureQuestion(new Error("socket closed")), /\/retry/);
});
