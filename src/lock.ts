import {
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { HlaoError } from "./errors.js";
import { lockPath } from "./paths.js";
import { normalizeProtocolVersion } from "./protocol.js";
import { connectStream, pathTarget, type WireStream } from "./stream.js";

export interface LockInfo {
  pid: number;
  token: string;
  endpoint: string;
  /** Wire protocol major version. Minor version is negotiated through `hello`. */
  protocolVersion: number;
  startedAt: string;
  version: string;
  state: "starting" | "running";
}

export function readLock(home: string): LockInfo | null {
  const file = lockPath(home);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      typeof value.endpoint !== "string" ||
      value.endpoint.length === 0 ||
      typeof value.protocolVersion !== "number" ||
      typeof value.startedAt !== "string" ||
      typeof value.version !== "string" ||
      (value.state !== "starting" && value.state !== "running")
    ) {
      return null;
    }
    return value as unknown as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Creates the lock only if no file exists. Returns false when another owner won.
 * The content is written to a temp file and linked into place, so a reader can
 * never observe a half-written lock.
 */
export function writeLockExclusive(home: string, info: LockInfo): boolean {
  const file = lockPath(home);
  const content = `${JSON.stringify(info, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;

  try {
    writeFileSync(temp, content, { mode: 0o600 });
    try {
      linkSync(temp, file);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // Hard links are unavailable on a few filesystems; fall back to the
      // exclusive create, whose partial-write window is tiny.
      try {
        writeFileSync(file, content, { flag: "wx", mode: 0o600 });
        return true;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw fallbackError;
      }
    }
  } catch (error) {
    throw new HlaoError(
      "internal",
      `cannot write ${file}: ${(error as Error).message}`,
    );
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Already moved or never created.
    }
  }
}

/**
 * Updates the lock atomically; readers see either the old or the new content.
 * Windows can briefly refuse the rename while a reader holds the file, so this
 * retries and reports failure rather than taking the supervisor down: the
 * acquire-time content is already usable.
 */
export async function updateLock(home: string, info: LockInfo): Promise<boolean> {
  const file = lockPath(home);
  const content = `${JSON.stringify(info, null, 2)}\n`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    try {
      writeFileSync(temp, content, { mode: 0o600 });
      renameSync(temp, file);
      return true;
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // Never created.
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  return false;
}

/** Removes the lock only when it still belongs to `token` (when provided). */
export function removeLock(home: string, token?: string): void {
  const current = readLock(home);
  if (token !== undefined && current && current.token !== token) return;
  try {
    unlinkSync(lockPath(home));
  } catch {
    // Already gone.
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The result of a liveness probe. `alive` means the endpoint answered a
 * token-checked hello; `major` is the wire major it reported. A live
 * supervisor of another major must be reported, never treated as a crash.
 */
export interface SupervisorProbe {
  alive: boolean;
  major: number | null;
}

/**
 * A cheap liveness + token check used during startup and autostart. The hello
 * deliberately carries no protocol version: an older supervisor accepts it and
 * reports its own, so the caller can distinguish "not answering" from "alive,
 * speaking major N" before deciding whether the lock is stale.
 */
export function probeSupervisor(
  info: LockInfo,
  timeoutMs = 750,
): Promise<SupervisorProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let stream: WireStream | null = null;
    const timer = setTimeout(() => finish(false, null), timeoutMs);
    timer.unref?.();

    function finish(alive: boolean, major: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream?.terminate();
      resolve({ alive, major });
    }

    void connectStream(pathTarget(info.endpoint), { timeoutMs })
      .then((opened) => {
        if (settled) {
          opened.terminate();
          return;
        }
        stream = opened;
        opened.onFrame((line) => {
          try {
            const response = JSON.parse(line) as {
              ok?: boolean;
              result?: { protocolVersion?: unknown };
            };
            if (response.ok !== true) {
              finish(false, null);
              return;
            }
            const normalized = normalizeProtocolVersion(
              response.result?.protocolVersion,
            );
            finish(true, normalized?.major ?? null);
          } catch {
            finish(false, null);
          }
        });
        opened.onError(() => finish(false, null));
        opened.onClose(() => finish(false, null));
        opened.write(
          `${JSON.stringify({
            id: 1,
            method: "hello",
            params: {},
            token: info.token,
          })}\n`,
        );
      })
      .catch(() => finish(false, null));
  });
}
