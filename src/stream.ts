import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { HlaoError } from "./errors.js";
import { MAX_FRAME_BYTES } from "./protocol.js";

/**
 * The transport-independent stream contract.
 *
 * The wire protocol is defined over application *frames*, not over a socket
 * implementation: one JSON object per frame, ordered, reliable, bidirectional,
 * with frame boundaries preserved. A transport adapter maps that contract onto
 * a concrete channel. NDJSON is the encoding for byte-stream transports (named
 * pipes, Unix sockets, TCP); a message-oriented transport carries one frame per
 * message and adds no delimiter.
 *
 * This module is deliberately presentation-free and auth-free. It moves frames;
 * the protocol decides what they mean and the caller decides whether the
 * transport is trusted.
 */

/** Where a stream endpoint lives. A new transport adds a variant here. */
export type StreamTarget =
  | { kind: "path"; path: string }
  | { kind: "tcp"; host: string; port: number };

/** The local IPC target used by named pipes and Unix domain sockets. */
export function pathTarget(path: string): StreamTarget {
  return { kind: "path", path };
}

function describeTarget(target: StreamTarget): string {
  return target.kind === "path" ? target.path : `${target.host}:${target.port}`;
}

/** A framing violation, as distinct from a transport failure. */
export class FrameTooLargeError extends Error {
  constructor() {
    super("request frame too large");
    this.name = "FrameTooLargeError";
  }
}

export interface WireStream {
  /** Writes one frame. The adapter appends the transport delimiter. */
  write(frame: string): void;
  /** Graceful close: flush pending writes, then FIN. */
  close(): void;
  /** Immediate teardown: drop buffered data and the connection. */
  terminate(): void;
  /** Bytes accepted by the adapter but not yet flushed to the peer. */
  bufferedBytes(): number;
  /**
   * Called for each complete frame. Frames that arrive before a handler is
   * attached are buffered, so a caller may register after connect/accept.
   */
  onFrame(handler: (frame: string) => void): void;
  onError(handler: (error: Error) => void): void;
  /** Called once when the connection is gone, after any error. */
  onClose(handler: () => void): void;
}

export interface StreamOptions {
  /** Maximum size of one inbound frame. Defaults to the protocol limit. */
  maxFrameBytes?: number;
}

export interface ConnectOptions extends StreamOptions {
  /** Bound on establishing the connection. Default 10s. */
  timeoutMs?: number;
}

export interface WireStreamServer {
  readonly target: StreamTarget;
  onConnection(handler: (stream: WireStream) => void): void;
  /** Errors after a successful listen, e.g. accept failures. */
  onError(handler: (error: Error) => void): void;
  /** The bound target; a TCP target with port 0 reports its assigned port. */
  endpoint(): StreamTarget;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One frame per newline on a byte stream. Decodes incrementally so a frame may
 * span chunks and a chunk may hold several frames.
 */
class NetWireStream implements WireStream {
  readonly #socket: Socket;
  readonly #maxFrameBytes: number;
  #buffer = "";
  #pending: string[] = [];
  #frameHandler: ((frame: string) => void) | null = null;
  #errorHandler: ((error: Error) => void) | null = null;
  #error: Error | null = null;
  #closeHandler: (() => void) | null = null;
  #closeEmitted = false;
  #failed = false;

  constructor(socket: Socket, maxFrameBytes: number) {
    this.#socket = socket;
    this.#maxFrameBytes = maxFrameBytes;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#consume(chunk);
    });
    socket.on("error", (error) => {
      this.#fail(error);
    });
    socket.on("close", () => {
      this.#emitClose();
    });
  }

  write(frame: string): void {
    if (this.#socket.destroyed) return;
    try {
      this.#socket.write(frame);
    } catch (error) {
      this.#fail(error as Error);
    }
  }

  close(): void {
    if (this.#socket.destroyed) return;
    try {
      this.#socket.end();
    } catch {
      // Already gone.
    }
  }

  terminate(): void {
    this.#emitClose();
    try {
      this.#socket.destroy();
    } catch {
      // Already gone.
    }
  }

  bufferedBytes(): number {
    return this.#socket.writableLength;
  }

  onFrame(handler: (frame: string) => void): void {
    this.#frameHandler = handler;
    const pending = this.#pending;
    this.#pending = [];
    for (const frame of pending) handler(frame);
  }

  onError(handler: (error: Error) => void): void {
    this.#errorHandler = handler;
    if (this.#error !== null) handler(this.#error);
  }

  onClose(handler: () => void): void {
    this.#closeHandler = handler;
    if (this.#closeEmitted) handler();
  }

  #consume(chunk: string): void {
    if (this.#failed || this.#closeEmitted) return;
    this.#buffer += chunk;

    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const frame = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(frame, "utf8") > this.#maxFrameBytes) {
        this.#fail(new FrameTooLargeError());
        return;
      }
      this.#emitFrame(frame);
    }

    // An unterminated frame already past the limit can never become valid.
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxFrameBytes) {
      this.#fail(new FrameTooLargeError());
    }
  }

  #emitFrame(frame: string): void {
    if (this.#frameHandler === null) {
      this.#pending.push(frame);
      return;
    }
    this.#frameHandler(frame);
  }

  #fail(error: Error): void {
    if (this.#failed || this.#closeEmitted) return;
    this.#failed = true;
    this.#error = error;
    if (this.#errorHandler !== null) this.#errorHandler(error);
    this.terminate();
  }

  #emitClose(): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.#closeHandler?.();
  }
}

/** Connects to a stream endpoint and resolves once the channel is usable. */
export function connectStream(
  target: StreamTarget,
  options: ConnectOptions = {},
): Promise<WireStream> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;

  return new Promise<WireStream>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const socket =
      target.kind === "path"
        ? connect(target.path)
        : connect({ host: target.host, port: target.port });

    const finish = (error?: HlaoError): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(new NetWireStream(socket, maxFrameBytes));
      }
    };

    const onConnect = (): void => finish();
    const onError = (error: Error): void => {
      finish(
        new HlaoError(
          "supervisor_unavailable",
          `supervisor connection failed: ${error.message}`,
        ),
      );
    };

    timer = setTimeout(() => {
      finish(
        new HlaoError(
          "supervisor_unavailable",
          `cannot connect to the supervisor at ${describeTarget(target)}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/** Creates a listener for a stream target. Call `listen()` to bind it. */
export function createWireServer(
  target: StreamTarget,
  options: StreamOptions = {},
): WireStreamServer {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  let connectionHandler: ((stream: WireStream) => void) | null = null;
  let postListenErrorHandler: ((error: Error) => void) | null = null;
  let listening = false;

  const server: Server = createServer((socket) => {
    const stream = new NetWireStream(socket, maxFrameBytes);
    if (connectionHandler === null) {
      stream.terminate();
      return;
    }
    connectionHandler(stream);
  });

  server.on("error", (error) => {
    if (!listening) return;
    postListenErrorHandler?.(error);
  });

  return {
    target,
    onConnection(handler) {
      connectionHandler = handler;
    },
    onError(handler) {
      postListenErrorHandler = handler;
    },
    endpoint() {
      const address = server.address();
      if (address === null || typeof address === "string") return target;
      return { kind: "tcp", host: address.address, port: address.port };
    },
    listen() {
      return new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          listening = true;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (target.kind === "path") {
          server.listen(target.path);
        } else {
          server.listen(target.port, target.host);
        }
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        server.close(() => finish());
        const fallback = setTimeout(() => {
          try {
            (server as unknown as { closeAllConnections?: () => void })
              .closeAllConnections?.();
          } catch {
            // Older runtimes.
          }
          finish();
        }, 2_000);
        fallback.unref?.();
      });
    },
  };
}
