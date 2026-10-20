import { isAbsolute } from "node:path";
import { HlaoError } from "../errors.js";
import type {
  EventType,
  Method,
  ParamsByMethod,
  ReloadParams,
  RequestEnvelope,
} from "./contract.js";
import { EVENT_TYPES } from "./contract.js";
import type { ProtocolVersion } from "./version.js";
import { MAX_PROMPT_CHARS } from "./version.js";

const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Boundary validation. Everything crossing the wire is checked here; the rest
// of the supervisor trusts the parsed value.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HlaoError("bad_request", `${what} must be an object`);
  }
  return value as JsonObject;
}

function checkKeys(object: JsonObject, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new HlaoError("bad_request", `${what} has unknown field "${key}"`);
    }
  }
}

function reqString(
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

function optString(
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

function optBoolean(object: JsonObject, key: string, what: string): boolean | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new HlaoError("bad_request", `${what}.${key} must be a boolean`);
  }
  return value;
}

function optInt(
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

function reqInt(
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

function optEnum<T extends string>(
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

function reqEnum<T extends string>(
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

function optPersistentStream(
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

function optSeqRecord(
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

function optProtocolVersion(
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

function optStringArray(
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

function eventTypeArray(
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

function absolutePath(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new HlaoError("bad_request", `${what} must be an absolute path`);
  }
  return value;
}

function stringRecord(
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

function configRecord(
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

export function parseEnvelope(value: unknown): RequestEnvelope {
  const object = asObject(value, "request");
  checkKeys(object, ["id", "method", "params", "token", "callerSessionId"], "request");

  const id = object.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new HlaoError("bad_request", "request.id must be a non-negative integer");
  }
  const method = reqString(object, "method", "request", 1, 100);
  const token = reqString(object, "token", "request", 1, 512);

  let callerSessionId: string | null = null;
  const rawCaller = object.callerSessionId;
  if (rawCaller !== undefined && rawCaller !== null) {
    if (typeof rawCaller !== "string" || rawCaller.length === 0 || rawCaller.length > 64) {
      throw new HlaoError("bad_request", "request.callerSessionId must be a session id");
    }
    callerSessionId = rawCaller;
  }

  return {
    id,
    method,
    params: object.params ?? {},
    token,
    callerSessionId,
  };
}

export function parseParams<M extends Method>(method: M, raw: unknown): ParamsByMethod[M] {
  const what = method;
  switch (method) {
    case "hello": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["protocolVersion", "stream"], what);
      return {
        protocolVersion: optProtocolVersion(object, "protocolVersion", what),
        stream: optPersistentStream(object, "stream", what),
      } as ParamsByMethod[M];
    }
    case "backends.list": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["cwd"], what);
      return {
        cwd: absolutePath(optString(object, "cwd", what, 1_000), `${what}.cwd`),
      } as ParamsByMethod[M];
    }
    case "sessions.spawn": {
      const object = asObject(raw, what);
      checkKeys(
        object,
        [
          "backend",
          "cwd",
          "name",
          "prompt",
          "wait",
          "timeoutMs",
          "mode",
          "model",
          "config",
          "parentSessionId",
          "permissionPolicy",
          "env",
          "skill",
          "idempotencyKey",
        ],
        what,
      );
      const prompt = optString(object, "prompt", what, MAX_PROMPT_CHARS);
      if (prompt !== undefined && prompt.length === 0) {
        throw new HlaoError("bad_request", `${what}.prompt must not be empty`);
      }
      return {
        backend: reqString(object, "backend", what, 1, 200),
        cwd: absolutePath(optString(object, "cwd", what, 1_000), `${what}.cwd`),
        name: optString(object, "name", what, 200),
        prompt,
        wait: optBoolean(object, "wait", what),
        timeoutMs: optInt(object, "timeoutMs", what, 0, MAX_TIMEOUT_MS),
        mode: optString(object, "mode", what, 100),
        model: optString(object, "model", what, 200),
        config: configRecord(object, "config", what),
        parentSessionId: optString(object, "parentSessionId", what, 64),
        permissionPolicy: optEnum(object, "permissionPolicy", what, [
          "ask",
          "allow",
          "deny",
        ] as const),
        env: stringRecord(object, "env", what),
        skill: optBoolean(object, "skill", what),
        idempotencyKey: optString(object, "idempotencyKey", what, 200),
      } as ParamsByMethod[M];
    }
    case "sessions.list": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["includeClosed", "cwd"], what);
      return {
        includeClosed: optBoolean(object, "includeClosed", what),
        cwd: absolutePath(optString(object, "cwd", what, 1_000), `${what}.cwd`),
      } as ParamsByMethod[M];
    }
    case "sessions.get": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
      } as ParamsByMethod[M];
    }
    case "sessions.cancel": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "keepQueue"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        keepQueue: optBoolean(object, "keepQueue", what),
      } as ParamsByMethod[M];
    }
    case "sessions.send": {
      const object = asObject(raw, what);
      checkKeys(
        object,
        ["sessionId", "text", "wait", "timeoutMs", "messageId", "idempotencyKey"],
        what,
      );
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        text: reqString(object, "text", what, 1, MAX_PROMPT_CHARS),
        wait: optBoolean(object, "wait", what),
        timeoutMs: optInt(object, "timeoutMs", what, 0, MAX_TIMEOUT_MS),
        messageId: optString(object, "messageId", what, 100),
        idempotencyKey: optString(object, "idempotencyKey", what, 200),
      } as ParamsByMethod[M];
    }
    case "sessions.read": {
      const object = asObject(raw, what);
      checkKeys(
        object,
        ["sessionId", "since", "before", "limit", "raw", "types", "turn", "grep"],
        what,
      );
      const since = optInt(object, "since", what, 0, Number.MAX_SAFE_INTEGER);
      const before = optInt(object, "before", what, 0, Number.MAX_SAFE_INTEGER);
      if (since !== undefined && before !== undefined) {
        throw new HlaoError(
          "bad_request",
          `${what}.since and ${what}.before are mutually exclusive`,
        );
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        since,
        before,
        limit: optInt(object, "limit", what, 1, 1_000),
        raw: optBoolean(object, "raw", what),
        types: eventTypeArray(object, "types", what),
        turn: optInt(object, "turn", what, 0, Number.MAX_SAFE_INTEGER),
        grep: optString(object, "grep", what, 500),
      } as ParamsByMethod[M];
    }
    case "sessions.wait": {
      const object = asObject(raw, what);
      checkKeys(
        object,
        [
          "sessionId",
          "sessionIds",
          "mode",
          "until",
          "since",
          "types",
          "grep",
          "timeoutMs",
        ],
        what,
      );
      const sessionId = optString(object, "sessionId", what, 64);
      if (sessionId !== undefined && sessionId.length === 0) {
        throw new HlaoError("bad_request", `${what}.sessionId must not be empty`);
      }
      const sessionIds = optStringArray(object, "sessionIds", what, 100);
      if ((sessionId === undefined) === (sessionIds === undefined)) {
        throw new HlaoError(
          "bad_request",
          `${what} requires exactly one of sessionId or sessionIds`,
        );
      }
      if (sessionIds !== undefined && new Set(sessionIds).size !== sessionIds.length) {
        throw new HlaoError("bad_request", `${what}.sessionIds must not repeat an id`);
      }
      const since = optInt(object, "since", what, 0, Number.MAX_SAFE_INTEGER);
      if (since !== undefined && (sessionIds?.length ?? 0) > 1) {
        throw new HlaoError(
          "bad_request",
          `${what}.since is only valid with a single session id`,
        );
      }
      const until =
        optEnum(object, "until", what, [
          "idle",
          "settled",
          "permission",
          "exit",
          "change",
        ] as const) ?? "idle";
      const types = eventTypeArray(object, "types", what);
      const grep = optString(object, "grep", what, 500);
      if ((types !== undefined || grep !== undefined) && until !== "change") {
        throw new HlaoError(
          "bad_request",
          `${what}.types and ${what}.grep require until: "change"`,
        );
      }
      return {
        sessionId,
        sessionIds,
        mode: optEnum(object, "mode", what, ["any", "all"] as const),
        until,
        since,
        types,
        grep,
        timeoutMs: optInt(object, "timeoutMs", what, 0, MAX_TIMEOUT_MS),
      } as ParamsByMethod[M];
    }
    case "sessions.close": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "force"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        force: optBoolean(object, "force", what),
      } as ParamsByMethod[M];
    }
    case "sessions.permit": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "optionId", "requestId", "always"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        optionId: optString(object, "optionId", what, 500),
        requestId: optString(object, "requestId", what, 200),
        always: optBoolean(object, "always", what),
      } as ParamsByMethod[M];
    }
    case "sessions.set_mode": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "modeId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        modeId: reqString(object, "modeId", what, 1, 100),
      } as ParamsByMethod[M];
    }
    case "sessions.set_policy": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "permissionPolicy"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        permissionPolicy: reqEnum(object, "permissionPolicy", what, [
          "ask",
          "allow",
          "deny",
        ] as const),
      } as ParamsByMethod[M];
    }
    case "sessions.set_config_option": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "configId", "value"], what);
      const value = object.value;
      if (typeof value !== "string" && typeof value !== "boolean") {
        throw new HlaoError(
          "bad_request",
          `${what}.value must be a string or boolean`,
        );
      }
      if (typeof value === "string" && value.length > 500) {
        throw new HlaoError(
          "bad_request",
          `${what}.value must be at most 500 characters`,
        );
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        configId: reqString(object, "configId", what, 1, 100),
        value,
      } as ParamsByMethod[M];
    }
    case "sessions.queue": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
      } as ParamsByMethod[M];
    }
    case "sessions.queue_drop": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "position", "messageId"], what);
      const position = optInt(object, "position", what, 1, 1_000);
      const messageId = optString(object, "messageId", what, 100);
      if ((position === undefined) === (messageId === undefined)) {
        throw new HlaoError(
          "bad_request",
          `${what} requires exactly one of position or messageId`,
        );
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        position,
        messageId,
      } as ParamsByMethod[M];
    }
    case "sessions.rename": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "name"], what);
      if (!("name" in object)) {
        throw new HlaoError("bad_request", `${what}.name is required (use null to clear)`);
      }
      const name = object.name;
      if (
        name !== null &&
        (typeof name !== "string" || name.trim().length === 0 || name.length > 200)
      ) {
        throw new HlaoError(
          "bad_request",
          `${what}.name must be a non-empty string of at most 200 characters, or null`,
        );
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        name: name as string | null,
      } as ParamsByMethod[M];
    }
    case "sessions.forget": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
      } as ParamsByMethod[M];
    }
    case "stream.subscribe": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["sessionIds", "fleet", "since"], what);
      const sessionIds = optStringArray(object, "sessionIds", what, 100);
      if (
        sessionIds !== undefined &&
        new Set(sessionIds).size !== sessionIds.length
      ) {
        throw new HlaoError("bad_request", `${what}.sessionIds must not repeat an id`);
      }
      const fleet = optBoolean(object, "fleet", what);
      if ((sessionIds?.length ?? 0) === 0 && fleet !== true) {
        throw new HlaoError(
          "bad_request",
          `${what} requires sessionIds or fleet: true`,
        );
      }
      return {
        sessionIds,
        fleet,
        since: optSeqRecord(object, "since", what),
      } as ParamsByMethod[M];
    }
    case "stream.unsubscribe": {
      const object = asObject(raw, what);
      checkKeys(object, ["subscription"], what);
      return {
        subscription: reqInt(
          object,
          "subscription",
          what,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
      } as ParamsByMethod[M];
    }
    case "supervisor.reload": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, [], what);
      return object as ReloadParams as ParamsByMethod[M];
    }
    case "supervisor.shutdown": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["force"], what);
      return {
        force: optBoolean(object, "force", what),
      } as ParamsByMethod[M];
    }
    default: {
      const unreachable: never = method;
      throw new HlaoError("bad_request", `unknown method ${String(unreachable)}`);
    }
  }
}
