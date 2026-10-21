import type { LockInfo } from "../lock.js";
import type { Method, NotificationFrame } from "../protocol.js";

export interface ConnectionOptions {
  home: string;
  cliPath: string;
  callerSessionId: string | null;
  /** Autostart a detached supervisor when none is reachable. Default true. */
  autostart?: boolean;
  /** How long to wait for a starting supervisor. Default 30s. */
  startupTimeoutMs?: number;
  /**
   * Accept a supervisor with a different wire major. Only `down` uses this, so
   * the upgrade path can stop a running old-major supervisor with its own
   * `sessions.list`/`supervisor.shutdown`. Normal commands require major
   * equality and report `version_mismatch`.
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
