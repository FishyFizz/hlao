import { resolve } from "node:path";
import { toHlaoError } from "../errors.js";
import { isWindows } from "../paths.js";
import type { ResponseEnvelope } from "../protocol.js";

export function actor(caller: string | null): string {
  return caller ?? "operator";
}

/** Windows paths are case-insensitive; `--cwd` must agree with `--cwd-prefix`. */
export function pathKey(value: string): string {
  const normalized = resolve(value);
  return isWindows() ? normalized.toLowerCase() : normalized;
}

export function failure(id: number, error: unknown): ResponseEnvelope {
  const converted = toHlaoError(error);
  return {
    id,
    ok: false,
    error: {
      code: converted.code,
      message: converted.message,
      ...(converted.details !== undefined ? { details: converted.details } : {}),
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
