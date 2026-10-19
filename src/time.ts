import { HlaoError } from "./errors.js";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses `500ms`, `30s`, `5m`, `2h`, `1d`, or a bare millisecond count.
 * Zero is allowed; callers decide whether it means "disabled".
 */
export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new HlaoError(
      "bad_request",
      `invalid duration "${value}" — use 500ms, 30s, 5m, 2h, or a millisecond count`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const result = amount * UNIT_MS[unit]!;
  if (!Number.isFinite(result) || result < 0) {
    throw new HlaoError("bad_request", `invalid duration "${value}"`);
  }
  return Math.round(result);
}

/** Human duration: `320ms`, `4s`, `2m 13s`, `1h 2m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
