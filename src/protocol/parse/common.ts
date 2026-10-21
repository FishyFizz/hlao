import { isAbsolute } from "node:path";
import { HlaoError } from "../../errors.js";
import type { Method } from "../methods.js";
import type { EventType } from "../views.js";
import { EVENT_TYPES } from "../views.js";
import type { ProtocolVersion } from "../version.js";

export const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Boundary validation primitives. Everything crossing the wire is checked
 * here; the rest of the supervisor trusts the parsed value.
 */

export type JsonObject = Record<string, unknown>;

const SYSTEM_METHODS = [
  "hello",
  "backends.list",
  "backends.sessions",
  "recovery.receipts",
  "stream.subscribe",
  "stream.unsubscribe",
  "supervisor.reload",
  "supervisor.shutdown",
] as const;

export type SystemMethod = (typeof SYSTEM_METHODS)[number];
export type SessionMethod = Exclude<Method, SystemMethod>;

export function isSystemMethod(method: Method): method is SystemMethod {
  return (SYSTEM_METHODS as readonly string[]).includes(method);
}

export function asObject(value: unknown, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HlaoError("bad_request", `${what} must be an object`);
  }
  return value as JsonObject;
}

export function checkKeys(
  object: JsonObject,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new HlaoError("bad_request", `${what} has unknown field "${key}"`);
    }
  }
}

export function reqString(
  object: JsonObject,
  key: string,
  what: string,
  min = 1,
  max = 1_000,
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new HlaoError("bad_request", `${what}.${key} must be a string`);
  }
  if (value.length < min) {
    throw new HlaoError("bad_request", `${what}.${key} must not be empty`);
  }
  if (value.length > max) {
    throw new HlaoError("bad_request", `${what}.${key} is too long`);
  }
  return value;
}

export function optString(
  object: JsonObject,
  key: string,
  what: string,
  max = 1_000,
): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HlaoError("bad_request", `${what}.${key} must be a string`);
  }
  if (value.length > max) {
    throw new HlaoError("bad_request", `${what}.${key} is too long`);
  }
  return value;
}

export function optBoolean(
  object: JsonObject,
  key: string,
  what: string,
): boolean | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new HlaoError("bad_request", `${what}.${key} must be a boolean`);
  }
  return value;
}

/** An ISO-8601 timestamp, normalized to UTC. `bad_request` when unparseable. */
export function optIso(
  object: JsonObject,
  key: string,
  what: string,
): string | undefined {
  const value = optString(object, key, what, 40);
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must be an ISO-8601 timestamp`,
    );
  }
  return new Date(parsed).toISOString();
}

export function optInt(
  object: JsonObject,
  key: string,
  what: string,
  min: number,
  max: number,
): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

export function reqInt(
  object: JsonObject,
  key: string,
  what: string,
  min: number,
  max: number,
): number {
  const value = optInt(object, key, what, min, max);
  if (value === undefined) {
    throw new HlaoError("bad_request", `${what}.${key} is required`);
  }
  return value;
}

export function optEnum<T extends string>(
  object: JsonObject,
  key: string,
  what: string,
  allowed: readonly T[],
): T | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

export function reqEnum<T extends string>(
  object: JsonObject,
  key: string,
  what: string,
  allowed: readonly T[],
): T {
  const value = optEnum(object, key, what, allowed);
  if (value === undefined) {
    throw new HlaoError("bad_request", `${what}.${key} is required`);
  }
  return value;
}

export function optPersistentStream(
  object: JsonObject,
  key: string,
  what: string,
): { persistent?: boolean } | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  const record = asObject(value, `${what}.${key}`);
  checkKeys(record, ["persistent"], `${what}.${key}`);
  return {
    persistent: optBoolean(record, "persistent", `${what}.${key}`),
  };
}

export function optSeqRecord(
  object: JsonObject,
  key: string,
  what: string,
): Record<string, number> | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  const record = asObject(value, `${what}.${key}`);
  const entries = Object.entries(record);
  if (entries.length > 100) {
    throw new HlaoError("bad_request", `${what}.${key} has too many entries`);
  }
  const out: Record<string, number> = {};
  for (const [id, seq] of entries) {
    if (id.length === 0 || id.length > 64) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key} keys must be session ids`,
      );
    }
    if (
      typeof seq !== "number" ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      seq > Number.MAX_SAFE_INTEGER
    ) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key}.${id} must be a non-negative integer`,
      );
    }
    out[id] = seq;
  }
  return out;
}

export function optProtocolVersion(
  object: JsonObject,
  key: string,
  what: string,
): ProtocolVersion | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  const record = asObject(value, `${what}.${key}`);
  checkKeys(record, ["major", "minor"], `${what}.${key}`);
  const major = reqInt(record, "major", `${what}.${key}`, 0, 1_000);
  const minor = reqInt(record, "minor", `${what}.${key}`, 0, 1_000);
  return { major, minor };
}

export function optStringArray(
  object: JsonObject,
  key: string,
  what: string,
  maxItems: number,
): string[] | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new HlaoError("bad_request", `${what}.${key} must be an array`);
  }
  if (value.length === 0) {
    throw new HlaoError("bad_request", `${what}.${key} must not be empty`);
  }
  if (value.length > maxItems) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must have at most ${maxItems} entries`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 64) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key}[${index}] must be a session id of at most 64 characters`,
      );
    }
    return entry;
  });
}

export function eventTypeArray(
  object: JsonObject,
  key: string,
  what: string,
): EventType[] | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new HlaoError("bad_request", `${what}.${key} must be an array`);
  }
  if (value.length === 0 || value.length > EVENT_TYPES.length) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must have between 1 and ${EVENT_TYPES.length} entries`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !(EVENT_TYPES as readonly string[]).includes(entry)) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key}[${index}] is not a known event type`,
      );
    }
    return entry as EventType;
  });
}

export function absolutePath(
  value: string | undefined,
  what: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new HlaoError("bad_request", `${what} must be an absolute path`);
  }
  return value;
}

export function stringRecord(
  object: JsonObject,
  key: string,
  what: string,
): Record<string, string> | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  const record = asObject(value, `${what}.${key}`);
  const entries = Object.entries(record);
  if (entries.length > 100) {
    throw new HlaoError("bad_request", `${what}.${key} has too many entries`);
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new HlaoError("bad_request", `${what}.${key} has invalid name "${name}"`);
    }
    if (typeof entry !== "string" || entry.length > 32_768) {
      throw new HlaoError("bad_request", `${what}.${key}.${name} must be a string`);
    }
    result[name] = entry;
  }
  return result;
}

export function configRecord(
  object: JsonObject,
  key: string,
  what: string,
): Record<string, string | boolean> | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  const record = asObject(value, `${what}.${key}`);
  const entries = Object.entries(record);
  if (entries.length > 50) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must have at most 50 entries`,
    );
  }
  const result: Record<string, string | boolean> = {};
  for (const [name, entry] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key} has an invalid option name "${name}"`,
      );
    }
    if (typeof entry !== "string" && typeof entry !== "boolean") {
      throw new HlaoError(
        "bad_request",
        `${what}.${key}.${name} must be a string or boolean`,
      );
    }
    if (typeof entry === "string" && entry.length > 500) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key}.${name} is too long`,
      );
    }
    result[name] = entry;
  }
  return result;
}
