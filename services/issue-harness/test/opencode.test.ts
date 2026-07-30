import assert from "node:assert/strict";
import test from "node:test";
import { parseParentSessionId } from "../src/opencode.js";

test("extracts only a bounded OpenCode parent marker from an Issue", () => {
  assert.equal(
    parseParentSessionId("<!-- opencode-harness-parent: ses_01JABCDEFGHJKMNPQRSTVWXYZ -->"),
    "ses_01JABCDEFGHJKMNPQRSTVWXYZ",
  );
  assert.equal(parseParentSessionId("<!-- opencode-harness-parent: ../../secret -->"), undefined);
});
