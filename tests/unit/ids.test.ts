import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_ID_ALPHABET,
  generateSessionId,
  isIdPrefix,
  isSessionId,
} from "../../src/ids.js";

test("session ids use the unambiguous alphabet", () => {
  const id = generateSessionId();
  assert.equal(id.length, 6);
  assert.ok(isSessionId(id));
  for (const character of id) {
    assert.ok(SESSION_ID_ALPHABET.includes(character));
  }
});

test("generation retries around collisions", () => {
  const seen = new Set<string>();
  const id = generateSessionId((candidate) => {
    if (seen.size < 3) {
      seen.add(candidate);
      return true;
    }
    return false;
  });
  assert.ok(isSessionId(id));
  assert.ok(!seen.has(id));
});

test("prefix matching requires a non-empty prefix", () => {
  assert.equal(isIdPrefix("abc", "abcdef"), true);
  assert.equal(isIdPrefix("abcdef", "abcdef"), true);
  assert.equal(isIdPrefix("abd", "abcdef"), false);
  assert.equal(isIdPrefix("", "abcdef"), false);
});

test("rejects malformed handles", () => {
  assert.equal(isSessionId("abc"), false);
  assert.equal(isSessionId("ABCDEF"), false);
  assert.equal(isSessionId("abcdei"), false);
  assert.equal(isSessionId("abcdeu"), false);
});
