import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { loadConfig } from "./config.js";
import { writeCrashMarker } from "./crash.js";
import { HlaoError, type HlaoErrorCode } from "./errors.js";
import {
  pidAlive,
  probeSupervisor,
  readLock,
  removeLock,
  type LockInfo,
} from "./lock.js";
import { ensureHome, logPath } from "./paths.js";
import {
  MAX_FRAME_BYTES,
  WIRE_PROTOCOL_MAJOR,
  WIRE_PROTOCOL_VERSION,
  type HelloResult,
  type Method,
  type NotificationFrame,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "./protocol.js";
import {
  FrameTooLargeError,
  connectStream,
  pathTarget,
  type WireStream,
} from "./stream.js";
import { nowIso } from "./time.js";
import { VERSION } from "./version.js";

let nextRequestId = 1;
let versionWarned = false;

export interface ConnectionOptions {
  home: string;
  cliPath: string;
  callerSessionId: string | null;
  /** Autostart a detached supervisor when none is reachable. Default true. */
  autostart?: boolean;
  /** How long to wait for a starting supervisor. Default 30s. */
  startupTimeoutMs?: number;
  /**
   * Accept a supervisor with a different wire major. Only `down` uses this, so a
   * 2.x CLI can stop a pre-2.0 supervisor during an upgrade. Normal commands must
   * require major equality.
   */
  allowLegacyProtocol?: boolean;
}

export interface RequestOptions {
  /**
   * Bound on the whole request, including connect. Default 60s; 0 means no
   * client-side bound (used for waits and spawns, which the supervisor bounds).
   */
  timeoutMs?: number;
}

export interface SupervisorConnection {
  lock: LockInfo;
  /** True when this connection autostarted the supervisor. */
  started?: boolean;
  request<T>(method: Method, params?: unknown, options?: RequestOptions): Promise<T>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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

async function ensureLock(
  options: ConnectionOptions,
): Promise<{ lock: LockInfo; started: boolean }> {
  let existing = readLock(options.home);
  if (existing && (await probeSupervisor(existing, 750))) {
    warnVersionMismatch(existing);
    return { lock: existing, started: false };
  }

  if (options.autostart === false) {
    throw new HlaoError(
      "supervisor_unavailable",
      "no supervisor is running (autostart disabled)",
    );
  }

  // A read-only probe must not create the runtime home. Only autostart does.
  ensureHome(options.home);

  if (existing) {
    const started = Date.parse(existing.startedAt);
    const age = Number.isFinite(started) ? Date.now() - started : Infinity;
    if (!pidAlive(existing.pid) || age > 30_000) {
      // A dead pid or an unreachable lock older than a startup window is stale.
      // Record the loss before removing it so the new supervisor can announce
      // it; the client removes the lock, so the supervisor never sees it.
      try {
        writeCrashMarker(options.home, {
          pid: existing.pid,
          version: existing.version,
          startedAt: existing.startedAt,
          detectedAt: nowIso(),
        });
      } catch {
        // The startup still proceeds; the log records the failure.
      }
      removeLock(options.home, existing.token);
      existing = null;
    }
  }
  let started = false;
  if (!existing) {
    // Fail before launching a process that cannot read its config: otherwise
    // the first command waits for a supervisor that will never answer and then
    // reports an empty instance instead of the parse error.
    const loaded = loadConfig(options.home);
    if (loaded.error) throw loaded.error;
    spawnSupervisor(options.home, options.cliPath);
    started = true;
  }

  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const deadline = Date.now() + startupTimeoutMs;
  let lastProblem = "no lock file appeared";
  while (Date.now() < deadline) {
    const lock = readLock(options.home);
    if (lock) {
      const expectedMajor = options.allowLegacyProtocol ? null : WIRE_PROTOCOL_MAJOR;
      if (expectedMajor !== null && lock.protocolVersion !== expectedMajor) {
        throw new HlaoError(
          "version_mismatch",
          `supervisor speaks wire protocol major ${lock.protocolVersion}; this CLI speaks ${WIRE_PROTOCOL_MAJOR}`,
        );
      }
      if (await probeSupervisor(lock, 500, expectedMajor)) {
        warnVersionMismatch(lock);
        return { lock, started };
      }
      lastProblem = `pid ${lock.pid} is not answering`;
    }
    await sleep(100);
  }

  throw new HlaoError(
    "supervisor_unavailable",
    `supervisor did not start within ${startupTimeoutMs / 1_000}s (${lastProblem}); see ${logPath(options.home)}`,
  );
}

function spawnSupervisor(home: string, cliPath: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, HLAO_HOME: home };
  for (const key of [
    "HLAO_SESSION_ID",
    "HLAO_PARENT_ID",
    "HLAO_ROOT_ID",
    "HLAO_DEPTH",
    "HLAO_BACKEND",
    "HLAO_CLI",
  ]) {
    delete env[key];
  }

  let logFd: number | null = null;
  try {
    logFd = openSync(logPath(home), "a");
    const child = spawn(process.execPath, [cliPath, "__supervisor"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });
    child.on("error", () => {
      // The startup poll reports the failure with the log path.
    });
    child.unref();
  } catch {
    // The startup poll reports the failure with the log path.
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        // Already closed.
      }
    }
  }
}

function requestOnce<T>(
  lock: LockInfo,
  callerSessionId: string | null,
  method: Method,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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
      reject(
        new HlaoError(
          "bad_request",
          `request is too large (${frameBytes} bytes; limit ${MAX_FRAME_BYTES})`,
        ),
      );
      return;
    }

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

export interface StreamingConnection {
  lock: LockInfo;
  /** True when this connection autostarted the supervisor. */
  started?: boolean;
  /** A request multiplexed over the persistent stream. */
  request<T>(method: Method, params?: unknown, options?: RequestOptions): Promise<T>;
  /** Server-initiated frames: session views, events, and removals. */
  onNotification(handler: (frame: NotificationFrame) => void): void;
  /** Called once when the stream is gone, unless `close()` caused it. */
  onClose(handler: () => void): void;
  close(): void;
}

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
      const id = nextRequestId;
      nextRequestId += 1;
      const envelope: RequestEnvelope = {
        id,
        method,
        params,
        token: lock.token,
        callerSessionId: options.callerSessionId,
      };
      const frame = `${JSON.stringify(envelope)}\n`;
      const frameBytes = Buffer.byteLength(frame, "utf8");
      if (frameBytes > MAX_FRAME_BYTES) {
        reject(
          new HlaoError(
            "bad_request",
            `request is too large (${frameBytes} bytes; limit ${MAX_FRAME_BYTES})`,
          ),
        );
        return;
      }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function warnVersionMismatch(lock: LockInfo): void {
  if (versionWarned || lock.version === VERSION) return;
  versionWarned = true;
  process.stderr.write(
    `hlao: supervisor ${lock.version} differs from CLI ${VERSION}; run "hlao down" and let the next command start ${VERSION}\n`,
  );
}
