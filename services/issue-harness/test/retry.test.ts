import assert from "node:assert/strict";
import test from "node:test";
import { retryTransient } from "../src/retry.js";

test("retries a transient operation without rerunning completed earlier work", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await retryTransient(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("temporary TLS failure");
    return "published";
  }, {
    attempts: 3,
    delayMs: 10,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  assert.equal(result, "published");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});
