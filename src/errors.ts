const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "version_mismatch",
  "not_found",
  "ambiguous_id",
  "forbidden",
  "operator_only",
  "backend_not_found",
  "backend_unavailable",
  "spawn_failed",
  "session_closed",
  "session_failed",
  "session_not_ready",
  "no_pending_permission",
  "bad_option",
  "timeout",
  "supervisor_unavailable",
  "config_invalid",
  "too_many_requests",
  "internal",
] as const;

export type HlaoErrorCode = (typeof ERROR_CODES)[number];

export class HlaoError extends Error {
  override readonly name = "HlaoError";

  constructor(
    readonly code: HlaoErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function toHlaoError(value: unknown): HlaoError {
  if (value instanceof HlaoError) return value;
  if (value instanceof Error) {
    return new HlaoError("internal", value.message);
  }
  return new HlaoError("internal", String(value));
}

/** A short, safe message for a stderr tail or an unexpected value. */
export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
