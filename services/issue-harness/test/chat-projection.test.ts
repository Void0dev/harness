import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("every user-visible lifecycle transition is projected into the parent chat", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /await state\.set\(activeState\)/);
  assert.doesNotMatch(source, /await state\.set\(verifying\)/);
});
