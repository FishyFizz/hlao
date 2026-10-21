import { HlaoError, toHlaoError } from "../errors.js";
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

/**
 * A config option that selects the provider's mode is a mode change. It gets
 * the same operator-only refusal as `mode` and `spawn --mode`, whichever
 * surface delivered it.
 */
export function modeConfigOperatorOnlyError(configId: string): HlaoError {
  return new HlaoError(
    "operator_only",
    "only an operator shell without HLAO_SESSION_ID may change a provider mode; " +
      `the config option "${configId}" selects it. Report the blocker to the operator.`,
  );
}
