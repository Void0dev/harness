import assert from "node:assert/strict";
import test from "node:test";
import { runtimeRequestAuthorized } from "../lib/runtime-auth.mjs";
import { createSessionCookie } from "../auth.mjs";

const internalToken = "i".repeat(32);
const sessionSecret = "s".repeat(32);

test("private runtime accepts only the internal bearer token", () => {
  const cookie = createSessionCookie({
    username: "developer",
    secret: sessionSecret,
    now: 1_000,
    ttlSeconds: 86_400,
    secure: false,
  });

  assert.equal(runtimeRequestAuthorized({
    runtimeMode: true,
    authorization: `Bearer ${internalToken}`,
    cookieHeader: undefined,
    internalToken,
  }), true);
  assert.equal(runtimeRequestAuthorized({
    runtimeMode: true,
    authorization: undefined,
    cookieHeader: cookie.header,
    internalToken,
    expectedUsername: "developer",
    sessionSecret,
  }), false);
});

test("legacy combined mode still accepts a signed web session", () => {
  const cookie = createSessionCookie({
    username: "developer",
    secret: sessionSecret,
    now: 1_000,
    ttlSeconds: 86_400,
    secure: false,
  });
  assert.equal(runtimeRequestAuthorized({
    runtimeMode: false,
    authorization: undefined,
    cookieHeader: cookie.header,
    internalToken,
    expectedUsername: "developer",
    sessionSecret,
    now: 1_001,
  }), true);
});
