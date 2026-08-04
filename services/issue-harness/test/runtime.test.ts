import assert from "node:assert/strict";
import test from "node:test";
import { HarnessRuntime } from "../src/runtime.js";

test("serializes the complete polling cycle instead of overlapping reconciliation", async () => {
  const runtime = new HarnessRuntime();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });

  const first = runtime.runExclusive(async () => {
    calls += 1;
    await blocked;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runtime.runExclusive(async () => { calls += 1; });

  assert.equal(second, "busy");
  assert.equal(calls, 1);
  release();
  assert.equal(await first, "completed");
});

test("stops timers, closes servers, waits for active work, and releases the process lock", async () => {
  const startedAt = Date.now();
  const events: string[] = [];
  const runtime = new HarnessRuntime();
  let releaseWork!: () => void;
  const workBlocked = new Promise<void>((resolve) => { releaseWork = resolve; });
  const work = runtime.runExclusive(async () => {
    events.push("work-started");
    await workBlocked;
    events.push("work-finished");
  });
  runtime.registerServer({
    close(callback: (error?: Error) => void) {
      events.push("server-closed");
      callback();
    },
  });
  const timer = runtime.registerInterval(() => events.push("timer-fired"), 60_000);
  assert.equal(timer.hasRef(), false);

  const stopping = runtime.stop(async () => { events.push("lock-released"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["work-started", "server-closed"]);
  releaseWork();
  const [, stopResult] = await Promise.all([work, stopping]);

  assert.deepEqual(events, ["work-started", "server-closed", "work-finished", "lock-released"]);
  assert.equal(stopResult, "graceful");
  assert.ok(Date.now() - startedAt < 500, "graceful shutdown must not wait for the deadline timer");
  assert.equal(await runtime.runExclusive(async () => undefined), "stopping");
});

test("releases the process lock when active work fails during shutdown", async () => {
  const runtime = new HarnessRuntime();
  let failWork!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, reject) => { failWork = reject; });
  const work = runtime.runExclusive(async () => blocked);
  await new Promise((resolve) => setImmediate(resolve));
  let released = false;
  const stopping = runtime.stop(async () => { released = true; });

  failWork(new Error("poll failed"));

  await assert.rejects(work, /poll failed/);
  await assert.rejects(stopping, /poll failed/);
  assert.equal(released, true);
});

test("aborts active work and returns after the shutdown grace period", async () => {
  const runtime = new HarnessRuntime();
  const work = runtime.runExclusive(async () => new Promise<void>(() => {}));
  await new Promise((resolve) => setImmediate(resolve));
  let released = false;

  const result = await runtime.stop(async () => { released = true; }, 5);

  assert.equal(result, "timed-out");
  assert.equal(runtime.signal.aborted, true);
  assert.equal(released, true);
  void work;
});

test("includes process-lock release in the shutdown grace period", async () => {
  const runtime = new HarnessRuntime();
  const stopping = runtime.stop(async () => new Promise<void>(() => {}), 5);
  const result = await Promise.race([
    stopping,
    new Promise<"outer-timeout">((resolve) => setTimeout(() => resolve("outer-timeout"), 100)),
  ]);

  assert.equal(result, "timed-out");
});
