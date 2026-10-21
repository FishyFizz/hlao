import { parseDuration } from "../time.js";
import { usageError } from "./args.js";

const DURATION_LIKE = /^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/;

/**
 * Parses a time bound for `--after` / `--until`. Accepts an ISO-8601
 * timestamp, `now`, or a duration with a unit (`30m`, `2h`, `7d`) meaning
 * "that long ago". Bare numbers are rejected because they are ambiguous
 * between epoch milliseconds and a millisecond duration.
 */
export function parseTimeBound(value: string, what: string, now = Date.now()): number {
  const trimmed = value.trim();
  if (trimmed === "now") return now;
  if (DURATION_LIKE.test(trimmed)) return now - parseDuration(trimmed);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw usageError(
      `${what} must be an ISO-8601 timestamp, "now", or a duration like 30m, 2h, or 7d`,
    );
  }
  return parsed;
}

export function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
