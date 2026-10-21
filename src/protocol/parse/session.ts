import { HlaoError } from "../../errors.js";
import type { ParamsByMethod } from "../methods.js";
import { MAX_PROMPT_CHARS } from "../version.js";
import {
  absolutePath,
  asObject,
  checkKeys,
  configRecord,
  eventTypeArray,
  MAX_TIMEOUT_MS,
  optBoolean,
  optEnum,
  optInt,
  optIso,
  optString,
  optStringArray,
  reqEnum,
  reqString,
  stringRecord,
  type SessionMethod,
} from "./common.js";

/** Boundary validation for the session and queue methods. */
export function parseSessionParams<M extends SessionMethod>(
  method: M,
  raw: unknown,
): ParamsByMethod[M] {
  const what = method;
  switch (method) {
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
          "env",
          "skill",
          "idempotencyKey",
          "resumeSessionId",
          "forkSessionId",
        ],
        what,
      );
      const resumeSessionId = optString(object, "resumeSessionId", what, 200);
      const forkSessionId = optString(object, "forkSessionId", what, 200);
      if (resumeSessionId !== undefined && forkSessionId !== undefined) {
        throw new HlaoError(
          "bad_request",
          `${what} cannot set both resumeSessionId and forkSessionId`,
        );
      }
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
        env: stringRecord(object, "env", what),
        skill: optBoolean(object, "skill", what),
        idempotencyKey: optString(object, "idempotencyKey", what, 200),
        resumeSessionId,
        forkSessionId,
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
        [
          "sessionId",
          "text",
          "wait",
          "timeoutMs",
          "messageId",
          "idempotencyKey",
          "steer",
        ],
        what,
      );
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        text: reqString(object, "text", what, 1, MAX_PROMPT_CHARS),
        wait: optBoolean(object, "wait", what),
        timeoutMs: optInt(object, "timeoutMs", what, 0, MAX_TIMEOUT_MS),
        messageId: optString(object, "messageId", what, 100),
        idempotencyKey: optString(object, "idempotencyKey", what, 200),
        steer: optBoolean(object, "steer", what),
      } as ParamsByMethod[M];
    }
    case "sessions.read": {
      const object = asObject(raw, what);
      checkKeys(
        object,
        [
          "sessionId",
          "since",
          "before",
          "limit",
          "raw",
          "types",
          "turn",
          "grep",
          "afterAt",
          "beforeAt",
          "regex",
          "context",
        ],
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
      const afterAt = optIso(object, "afterAt", what);
      const beforeAt = optIso(object, "beforeAt", what);
      if (
        afterAt !== undefined &&
        beforeAt !== undefined &&
        Date.parse(afterAt) >= Date.parse(beforeAt)
      ) {
        throw new HlaoError(
          "bad_request",
          `${what}.afterAt must be earlier than ${what}.beforeAt`,
        );
      }
      const grep = optString(object, "grep", what, 500);
      const regex = optBoolean(object, "regex", what);
      if (regex === true) {
        if (grep === undefined || grep.length === 0) {
          throw new HlaoError(
            "bad_request",
            `${what}.regex requires a non-empty ${what}.grep`,
          );
        }
        try {
          new RegExp(grep, "i");
        } catch (error) {
          throw new HlaoError(
            "bad_request",
            `${what}.grep is not a valid regular expression: ${(error as Error).message}`,
          );
        }
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        since,
        before,
        limit: optInt(object, "limit", what, 1, 1_000),
        raw: optBoolean(object, "raw", what),
        types: eventTypeArray(object, "types", what),
        turn: optInt(object, "turn", what, 0, Number.MAX_SAFE_INTEGER),
        grep,
        afterAt,
        beforeAt,
        regex,
        context: optInt(object, "context", what, 0, 20),
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
      checkKeys(object, ["sessionId", "optionId", "requestId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        optionId: reqString(object, "optionId", what, 1, 500),
        requestId: optString(object, "requestId", what, 200),
      } as ParamsByMethod[M];
    }
    case "sessions.respond_elicitation": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "requestId", "action", "content"], what);
      const action = reqEnum(object, "action", what, [
        "accept",
        "decline",
        "cancel",
      ] as const);
      let content:
        | Record<string, string | number | boolean | string[]>
        | undefined;
      const rawContent = object.content;
      if (rawContent !== undefined && rawContent !== null) {
        if (typeof rawContent !== "object" || Array.isArray(rawContent)) {
          throw new HlaoError("bad_request", `${what}.content must be an object`);
        }
        content = {};
        for (const [key, value] of Object.entries(rawContent)) {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            content[key] = value;
          } else if (
            Array.isArray(value) &&
            value.every((item) => typeof item === "string")
          ) {
            content[key] = value;
          } else {
            throw new HlaoError(
              "bad_request",
              `${what}.content.${key} must be a string, number, boolean, or string array`,
            );
          }
        }
      }
      if (action !== "accept" && content !== undefined) {
        throw new HlaoError(
          "bad_request",
          `${what}.content requires action "accept"`,
        );
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        requestId: optString(object, "requestId", what, 200),
        action,
        content,
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
    default: {
      const unreachable: never = method;
      throw new HlaoError(
        "bad_request",
        `unknown method ${String(unreachable)}`,
      );
    }
  }
}
