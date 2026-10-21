import { HlaoError, type HlaoErrorCode } from "../errors.js";
import type { LockInfo } from "../lock.js";
import {
  MAX_FRAME_BYTES,
  type Method,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "../protocol.js";
import {
  FrameTooLargeError,
  connectStream,
  pathTarget,
  type WireStream,
} from "../stream.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

let nextRequestId = 1;

export interface PreparedRequest {
  id: number;
  frame: string;
}

/**
 * Allocate an id and serialize one request frame. Both connection modes share
 * this, so the wire shape and the frame bound have exactly one definition.
 */
export function prepareRequest(
  lock: LockInfo,
  callerSessionId: string | null,
  method: Method,
  params: unknown,
): PreparedRequest {
  const id = nextRequestId;
  nextRequestId += 1;
  const envelope: RequestEnvelope = {
    id,
    method,
    params,
    token: lock.token,
    callerSessionId,
  };
  const frame = `${JSON.stringify(envelope)}\n`;
  const frameBytes = Buffer.byteLength(frame, "utf8");
  if (frameBytes > MAX_FRAME_BYTES) {
    throw new HlaoError(
      "bad_request",
      `request is too large (${frameBytes} bytes; limit ${MAX_FRAME_BYTES})`,
    );
  }
  return { id, frame };
}

/** One request over a fresh connection; the connection ends with the answer. */
export function requestOnce<T>(
  lock: LockInfo,
  callerSessionId: string | null,
  method: Method,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { id, frame } = prepareRequest(lock, callerSessionId, method, params);

    let stream: WireStream | null = null;
    let settled = false;

    const finish = (error?: HlaoError, value?: T): void => {
      if (settled) return;
      settled = true;
      if (responseTimer) clearTimeout(responseTimer);
      stream?.terminate();
      if (error) reject(error);
      else resolve(value as T);
    };

    const responseTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(
              new HlaoError(
                "timeout",
                `supervisor did not answer ${method} within ${Math.round(timeoutMs / 1_000)}s`,
              ),
            );
          }, timeoutMs)
        : null;

    void connectStream(pathTarget(lock.endpoint), {
      timeoutMs: 10_000,
      maxFrameBytes: 32 * 1024 * 1024,
    })
      .then((opened) => {
        if (settled) {
          opened.terminate();
          return;
        }
        stream = opened;

        opened.onFrame((line) => {
          try {
            const response = JSON.parse(line) as ResponseEnvelope;
            if (!response.ok && response.id === 0) {
              finish(
                new HlaoError(
                  response.error.code as HlaoErrorCode,
                  response.error.message,
                  response.error.details,
                ),
              );
              return;
            }
            if (response.id !== id) {
              finish(
                new HlaoError(
                  "internal",
                  `supervisor answered request ${response.id}, expected ${id}`,
                ),
              );
              return;
            }
            if (response.ok) {
              finish(undefined, response.result as T);
            } else {
              finish(
                new HlaoError(
                  response.error.code as HlaoErrorCode,
                  response.error.message,
                  response.error.details,
                ),
              );
            }
          } catch (error) {
            finish(
              new HlaoError(
                "internal",
                `cannot parse supervisor response: ${(error as Error).message}`,
              ),
            );
          }
        });
        opened.onError((error) => {
          finish(
            error instanceof FrameTooLargeError
              ? new HlaoError("internal", "supervisor response was too large")
              : new HlaoError(
                  "supervisor_unavailable",
                  `supervisor connection failed: ${error.message}`,
                ),
          );
        });
        opened.onClose(() => {
          finish(
            new HlaoError(
              "supervisor_unavailable",
              "supervisor closed the connection without a response",
            ),
          );
        });

        opened.write(frame);
      })
      .catch((error: unknown) => {
        finish(
          error instanceof HlaoError
            ? error
            : new HlaoError(
                "supervisor_unavailable",
                `supervisor connection failed: ${(error as Error).message}`,
              ),
        );
      });
  });
}
