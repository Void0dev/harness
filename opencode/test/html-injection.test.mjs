import assert from "node:assert/strict";
import test from "node:test";
import { injectHarnessAssets } from "../lib/html-injection.mjs";

test("injects the Harness card assets into an HTML document exactly once", () => {
  const once = injectHarnessAssets("<!doctype html><html><head><title>OpenCode</title></head><body></body></html>");
  const twice = injectHarnessAssets(once);
  assert.match(once, /\/__harness\/task-card\.css/);
  assert.match(once, /\/__harness\/task-card\.mjs/);
  assert.equal(twice, once);
});

test("leaves non-document fragments unchanged", () => {
  assert.equal(injectHarnessAssets('{"ok":true}'), '{"ok":true}');
});
