import { HlaoError } from "../../errors.js";
import type { ParamsByMethod, ReloadParams } from "../methods.js";
import {
  absolutePath,
  asObject,
  checkKeys,
  optBoolean,
  optPersistentStream,
  optProtocolVersion,
  optSeqRecord,
  optString,
  optStringArray,
  reqInt,
  reqString,
  type SystemMethod,
} from "./common.js";

/** Boundary validation for the instance-level and stream methods. */
export function parseSystemParams<M extends SystemMethod>(
  method: M,
  raw: unknown,
): ParamsByMethod[M] {
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
    case "backends.sessions": {
      const object = asObject(raw, what);
      checkKeys(object, ["backend", "cwd", "cursor"], what);
      return {
        backend: reqString(object, "backend", what, 1, 200),
        cwd: absolutePath(optString(object, "cwd", what, 1_000), `${what}.cwd`),
        cursor: optString(object, "cursor", what, 4_096),
      } as ParamsByMethod[M];
    }
    case "recovery.receipts": {
      const object = asObject(raw, what);
      checkKeys(object, ["parentProviderId"], what);
      const parentProviderId = optString(
        object,
        "parentProviderId",
        what,
        4_096,
      );
      if (parentProviderId !== undefined && parentProviderId.length === 0) {
        throw new HlaoError(
          "bad_request",
          `${what}.parentProviderId must not be empty`,
        );
      }
      return { parentProviderId } as ParamsByMethod[M];
    }
    case "stream.subscribe": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["sessionIds", "fleet", "since"], what);
      const sessionIds = optStringArray(object, "sessionIds", what, 100);
      if (
        sessionIds !== undefined &&
        new Set(sessionIds).size !== sessionIds.length
      ) {
        throw new HlaoError(
          "bad_request",
          `${what}.sessionIds must not repeat an id`,
        );
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
      throw new HlaoError(
        "bad_request",
        `unknown method ${String(unreachable)}`,
      );
    }
  }
}
