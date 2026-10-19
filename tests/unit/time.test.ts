import assert from "node:assert/strict";
import { test } from "node:test";
import { HlaoError } from "../../src/errors.js";
import { formatDuration, parseDuration } from "../../src/time.js";

test("parseDuration accepts units and bare milliseconds", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("2s"), 2_000);
  assert.equal(parseDuration("1.5m"), 90_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("128"), 128);
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration(" 30s "), 30_000);
});

test("parseDuration rejects bad input with a stable code", () => {
  for (const input of ["", "abc", "-5s", "1w", "1.2.3s"]) {
    assert.throws(
      () => parseDuration(input),
      (error: unknown) =>
        error instanceof HlaoError && error.code === "bad_request",
    );
  }
});

test("formatDuration is stable and readable", () => {
  assert.equal(formatDuration(320), "320ms");
  assert.equal(formatDuration(4_000), "4s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(90_000_000), "1d 1h");
});
