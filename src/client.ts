import type { Method } from "./protocol.js";
import { ensureLock } from "./client/autostart.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  requestOnce,
} from "./client/request.js";
import type {
  ConnectionOptions,
  RequestOptions,
  SupervisorConnection,
} from "./client/types.js";

export type {
  ConnectionOptions,
  RequestOptions,
  StreamingConnection,
  SupervisorConnection,
} from "./client/types.js";
export { connectStreaming } from "./client/streaming.js";

/**
 * The bundled one-shot client: resolve (or start) the instance's supervisor,
 * then send one request per connection. State lives in the supervisor, never
 * here.
 */
export async function connectSupervisor(
  options: ConnectionOptions,
): Promise<SupervisorConnection> {
  const ensured = await ensureLock(options);
  const lock = ensured.lock;
  return {
    lock,
    started: ensured.started,
    request: <T>(
      method: Method,
      params: unknown = {},
      requestOptions: RequestOptions = {},
    ): Promise<T> =>
      requestOnce<T>(
        lock,
        options.callerSessionId,
        method,
        params,
        requestOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ),
  };
}
