import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCookie,
  credentialsMatch,
  parseSessionCookie,
  safeNextPath,
} from "../auth.mjs";

const secret = "s".repeat(32);

test("validates both username and password without partial matches", () => {
  assert.equal(credentialsMatch("developer", "correct-password", "developer", "correct-password"), true);
  assert.equal(credentialsMatch("developer", "wrong", "developer", "correct-password"), false);
  assert.equal(credentialsMatch("other", "correct-password", "developer", "correct-password"), false);
});

test("creates an HttpOnly session that remains valid for 24 hours", () => {
  const now = 1_000_000;
  const cookie = createSessionCookie({ username: "developer", secret, now, ttlSeconds: 86_400, secure: false });
  assert.match(cookie.header, /HttpOnly/);
  assert.match(cookie.header, /SameSite=Lax/);
  assert.match(cookie.header, /Max-Age=86400/);
  assert.doesNotMatch(cookie.header, /correct-password/);
  assert.deepEqual(parseSessionCookie(cookie.value, { secret, now: now + 86_399 }), { username: "developer" });
  assert.equal(parseSessionCookie(cookie.value, { secret, now: now + 86_401 }), undefined);
});

test("rejects a modified or differently signed session", () => {
  const cookie = createSessionCookie({ username: "developer", secret, now: 10, ttlSeconds: 86_400, secure: true });
  assert.match(cookie.header, /; Secure/);
  assert.equal(parseSessionCookie(`${cookie.value}x`, { secret, now: 11 }), undefined);
  assert.equal(parseSessionCookie(cookie.value, { secret: "x".repeat(32), now: 11 }), undefined);
});

test("allows only local paths as post-login destinations", () => {
  assert.equal(safeNextPath("/abc/session"), "/abc/session");
  assert.equal(safeNextPath("https://evil.example"), "/");
  assert.equal(safeNextPath("//evil.example"), "/");
  assert.equal(safeNextPath("login"), "/");
});
