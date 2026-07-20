import assert from "node:assert/strict";
import test from "node:test";
import { RunScheduler } from "../src/scheduler.js";

test("serializes overlapping issue claims before the first await completes", async () => {
  const scheduler = new RunScheduler<{ number: number }>(1, (issue) => issue.number);
  let nextIssueCalls = 0;
  let releaseClaim!: () => void;
  const claimBlocked = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const first = scheduler.poll(
    async () => {
      nextIssueCalls += 1;
      await claimBlocked;
      return { number: 1 };
    },
    async () => undefined,
  );
  await new Promise((resolve) => setImmediate(resolve));

  const second = await scheduler.poll(
    async () => {
      nextIssueCalls += 1;
      return { number: 1 };
    },
    async () => undefined,
  );

  assert.equal(second, "claim-in-progress");
  assert.equal(nextIssueCalls, 1);
  releaseClaim();
  assert.equal(await first, "processed");
});
