import assert from "node:assert/strict";
import test from "node:test";
import { isUsE164, normalizeE164 } from "./phone.js";

test("normalizes US numbers", () => {
  assert.equal(normalizeE164("(415) 555-0100"), "+14155550100");
  assert.equal(normalizeE164("+1 415 555 0100"), "+14155550100");
  assert.equal(isUsE164("+14155550100"), true);
  assert.equal(isUsE164("+4155550100"), false);
});

test("rejects short input", () => {
  assert.throws(() => normalizeE164("123"), /Invalid E\.164/);
});
