import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("the runtime wires native session creation into GitHub conversation creation", () => {
  const source = fs.readFileSync(new URL("../web-entry.mjs", import.meta.url), "utf8");
  const nativeEventImport = /import\s*\{([\s\S]*?)\}\s*from\s*["']\.\/lib\/native-events\.mjs["']/m.exec(source)?.[1] ?? "";

  assert.match(nativeEventImport, /\bsessionCreatedEvent\b/);
  assert.match(source, /\bfindGitHubIssueParentSession\s*\(/);
  assert.match(source, /\bmaterializeGitHubIssueConversation\s*\(/);
});
