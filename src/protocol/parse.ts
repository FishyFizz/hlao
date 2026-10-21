import { HlaoError } from "../errors.js";
import type {
  Method,
  ParamsByMethod,
  RequestEnvelope,
} from "./methods.js";
import { asObject, checkKeys, isSystemMethod, reqString } from "./parse/common.js";
import { parseSessionParams } from "./parse/session.js";
import { parseSystemParams } from "./parse/system.js";

export { MAX_TIMEOUT_MS } from "./parse/common.js";

/**
 * Boundary validation. Everything crossing the wire is checked here; the rest
 * of the supervisor trusts the parsed value.
 *
 * Method-specific validation lives in `parse/session.ts` and `parse/system.ts`;
 * this module only validates the envelope and dispatches.
 */

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

export function parseParams<M extends Method>(
  method: M,
  raw: unknown,
): ParamsByMethod[M] {
  if (isSystemMethod(method)) {
    return parseSystemParams(method, raw);
  }
  return parseSessionParams(method, raw) as ParamsByMethod[M];
}
