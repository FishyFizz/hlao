import { HlaoError, type HlaoErrorCode } from "../errors.js";
import {
  WIRE_PROTOCOL_VERSION,
  type HelloResult,
  type Method,
  type NotificationFrame,
  type ResponseEnvelope,
} from "../protocol.js";
import {
  FrameTooLargeError,
  connectStream,
  pathTarget,
} from "../stream.js";
import { ensureLock } from "./autostart.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  prepareRequest,
} from "./request.js";
import type {
  ConnectionOptions,
  RequestOptions,
  StreamingConnection,
} from "./types.js";

/**
 * A long-lived, multiplexed connection for subscriptions. The hello handshake
 * must complete before this resolves, so callers can subscribe immediately
 * without racing the supervisor's persistent-stream upgrade.
 */
export async function connectStreaming(
  options: ConnectionOptions,
): Promise<StreamingConnection> {
  const ensured = await ensureLock(options);
  const lock = ensured.lock;
  const stream = await connectStream(pathTarget(lock.endpoint), {
    timeoutMs: 10_000,
    maxFrameBytes: 32 * 1024 * 1024,
  });

  const notificationHandlers = new Set<(frame: NotificationFrame) => void>();
  const closeHandlers = new Set<() => void>();
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout | null;
    }
  >();
  let closed = false;
  let closing = false;
  let closeNotified = false;

  const notifyClose = (): void => {
    if (closeNotified || closing) return;
    closeNotified = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        // A close observer must not break teardown.
      }
    }
  };

  const failAll = (error: HlaoError): void => {
    for (const entry of pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  stream.onFrame((line) => {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (
      typeof frame === "object" &&
      frame !== null &&
      (frame as { type?: unknown }).type === "notification"
    ) {
      const notification = frame as NotificationFrame;
      for (const handler of notificationHandlers) {
        try {
          handler(notification);
        } catch {
          // One observer must not stop the others.
        }
      }
      return;
    }
    const response = frame as ResponseEnvelope;
    if (typeof response.id !== "number") return;
    const entry = pending.get(response.id);
    if (entry === undefined) return;
    pending.delete(response.id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(
        new HlaoError(
          response.error.code as HlaoErrorCode,
          response.error.message,
          response.error.details,
        ),
      );
    }
  });

  stream.onError((error) => {
    if (closed) return;
    closed = true;
    failAll(
      error instanceof FrameTooLargeError
        ? new HlaoError("internal", "supervisor frame was too large")
        : new HlaoError(
            "supervisor_unavailable",
            `supervisor stream failed: ${error.message}`,
          ),
    );
    notifyClose();
  });
  stream.onClose(() => {
    if (closed) return;
    closed = true;
    failAll(
      new HlaoError(
        "supervisor_unavailable",
        "supervisor closed the persistent stream",
      ),
    );
    notifyClose();
  });

  const request = <T>(
    method: Method,
    params: unknown = {},
    requestOptions: RequestOptions = {},
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new HlaoError("supervisor_unavailable", "stream is closed"));
        return;
      }
      const { id, frame } = prepareRequest(
        lock,
        options.callerSessionId,
        method,
        params,
      );
      const timeoutMs = requestOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(
                new HlaoError(
                  "timeout",
                  `supervisor did not answer ${method} within ${Math.round(timeoutMs / 1_000)}s`,
                ),
              );
            }, timeoutMs)
          : null;
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      stream.write(frame);
    });

  let hello: HelloResult;
  try {
    hello = await request<HelloResult>(
      "hello",
      {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        stream: { persistent: true },
      },
      { timeoutMs: 10_000 },
    );
  } catch (error) {
    stream.terminate();
    throw error;
  }
  if (hello.stream?.persistent !== true) {
    stream.terminate();
    throw new HlaoError(
      "supervisor_unavailable",
      "supervisor did not accept a persistent stream",
    );
  }

  return {
    lock,
    started: ensured.started,
    request,
    onNotification(handler) {
      notificationHandlers.add(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
    },
    close() {
      closing = true;
      stream.terminate();
    },
  };
}
