/**
 * The supervisor wire protocol. `major` changes only when a client written for
 * the previous major can no longer work; `minor` grows with additive methods and
 * fields. Clients require major equality and discover optional behavior through
 * `hello.capabilities`.
 */
export interface ProtocolVersion {
  major: number;
  minor: number;
}

export const WIRE_PROTOCOL_VERSION: ProtocolVersion = { major: 2, minor: 3 };
export const WIRE_PROTOCOL_MAJOR = WIRE_PROTOCOL_VERSION.major;

/**
 * Accepts the 0.4 object form and the pre-0.4 numeric form (interpreted as
 * `major.0`) so a new client can still talk to an older running supervisor.
 */
export function normalizeProtocolVersion(value: unknown): ProtocolVersion | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { major: value, minor: 0 };
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      typeof record.major === "number" &&
      Number.isInteger(record.major) &&
      record.major >= 0 &&
      typeof record.minor === "number" &&
      Number.isInteger(record.minor) &&
      record.minor >= 0
    ) {
      return { major: record.major, minor: record.minor };
    }
  }
  return null;
}

/** The ACP version HLAO speaks. Distinct from the supervisor wire version. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Additive protocol features a client may feature-detect. A capability is
 * present when the supervisor implements it; absence means the client must fall
 * back to the older behavior.
 */
export const PROTOCOL_CAPABILITIES = [
  "backends.list",
  "session.usage",
  "read.filters",
  "read.before",
  "wait.multi",
  "stream.persistent",
  "stream.subscribe",
  "stream.resume",
  "wait.settled",
  "wait.filters",
  "session.settled",
  "session.lastEvent",
  "send.messageId",
  "send.idempotency",
  "spawn.idempotency",
  "spawn.createdBy",
] as const;

export type ProtocolCapability = (typeof PROTOCOL_CAPABILITIES)[number];

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 1_000_000;
