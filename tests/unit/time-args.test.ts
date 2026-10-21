import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTimeBound } from "../../src/cli/time-args.js";
import { HlaoError } from "../../src/errors.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function rejects(value: string, what = "--after"): void {
  assert.throws(
    () => parseTimeBound(value, what, NOW),
    (error: unknown) =>
      error instanceof HlaoError &&
      error.code === "bad_request" &&
      error.message.includes(what),
    `${JSON.stringify(value)} must be rejected`,
  );
}

test("parseTimeBound accepts ISO-8601, now, and unit durations", () => {
  assert.equal(parseTimeBound("2026-10-21T10:00:00+08:00", "--after", NOW), NOW - 10 * 3_600_000);
  assert.equal(parseTimeBound("2026-10-21", "--after", NOW), Date.parse("2026-10-21"));
  assert.equal(parseTimeBound("now", "--after", NOW), NOW);
  assert.equal(parseTimeBound("30m", "--after", NOW), NOW - 30 * 60_000);
  assert.equal(parseTimeBound("2h", "--after", NOW), NOW - 2 * 3_600_000);
  assert.equal(parseTimeBound("7d", "--after", NOW), NOW - 7 * 86_400_000);
  assert.equal(parseTimeBound(" 1h ", "--until", NOW), NOW - 3_600_000);
});

test("parseTimeBound rejects bare numbers as ambiguous", () => {
  // Date.parse reads these as years, so without an explicit guard a mistyped
  // duration or epoch value silently becomes a plausible timestamp.
  for (const value of ["123", "2026", "-123", "+123", "1.5"]) {
    rejects(value);
  }
});

test("parseTimeBound rejects unparseable values and uppercase units", () => {
  for (const value of ["banana", "1H", "1w", ""]) {
    rejects(value);
  }
});
