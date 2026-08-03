import assert from "node:assert/strict";
import test from "node:test";
import { runtimeRequestAuthorized } from "../lib/runtime-auth.mjs";

const internalToken = "i".repeat(32);

test("private runtime accepts only the internal bearer token", () => {
  assert.equal(runtimeRequestAuthorized({
    authorization: `Bearer ${internalToken}`,
    internalToken,
  }), true);
  assert.equal(runtimeRequestAuthorized({
    authorization: undefined,
    internalToken,
  }), false);
  assert.equal(runtimeRequestAuthorized({
    authorization: `Bearer ${"x".repeat(32)}`,
    internalToken,
  }), false);
});
