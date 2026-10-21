import { toHlaoError } from "../errors.js";
import type { ResponseEnvelope } from "../protocol.js";

export function actor(caller: string | null): string {
  return caller ?? "operator";
}

export { pathKey } from "../paths.js";

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
