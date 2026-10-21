import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { loadConfig } from "../config.js";
import { writeCrashMarker } from "../crash.js";
import { HlaoError } from "../errors.js";
import { pidAlive, probeSupervisor, readLock, removeLock, type LockInfo } from "../lock.js";
import { ensureHome, logPath } from "../paths.js";
import { WIRE_PROTOCOL_MAJOR } from "../protocol.js";
import { nowIso } from "../time.js";
import { VERSION } from "../version.js";
import type { ConnectionOptions } from "./types.js";

let versionWarned = false;

/**
 * Resolve a live supervisor lock, starting a detached supervisor when needed.
 * A read-only probe never creates the runtime home; only autostart does.
 */
export async function ensureLock(
  options: ConnectionOptions,
): Promise<{ lock: LockInfo; started: boolean }> {
  let existing = readLock(options.home);
  if (existing) {
    const probe = await probeSupervisor(existing, 750);
    if (probe.alive) {
      // A live supervisor of another major is a version fact, not a crash.
      // Never remove its lock or try to replace it.
      if (probe.major !== WIRE_PROTOCOL_MAJOR && options.allowLegacyProtocol !== true) {
        throw versionMismatch(probe.major);
      }
      warnVersionMismatch(existing);
      return { lock: existing, started: false };
    }
  }

  if (options.autostart === false) {
    throw new HlaoError(
      "supervisor_unavailable",
      "no supervisor is running (autostart disabled)",
    );
  }

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
      const legacyAllowed = options.allowLegacyProtocol === true;
      if (!legacyAllowed && lock.protocolVersion !== WIRE_PROTOCOL_MAJOR) {
        throw versionMismatch(lock.protocolVersion);
      }
      const probe = await probeSupervisor(lock, 500);
      if (probe.alive) {
        if (!legacyAllowed && probe.major !== WIRE_PROTOCOL_MAJOR) {
          throw versionMismatch(probe.major);
        }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A live old-major supervisor is reported before any command touches it. The
 * operator stops it with the old CLI, or with `hlao down` (which uses the
 * legacy connection path), then starts 0.15.
 */
function versionMismatch(major: number | null): HlaoError {
  return new HlaoError(
    "version_mismatch",
    `the running supervisor speaks wire protocol major ${major ?? "unknown"}; this CLI speaks ${WIRE_PROTOCOL_MAJOR}. Stop the old supervisor with its own CLI ("hlao down") or with "hlao down" from this CLI (legacy path), then retry so 0.15 can start. The old supervisor's lock was left in place.`,
    { supervisorMajor: major, clientMajor: WIRE_PROTOCOL_MAJOR },
  );
}

function warnVersionMismatch(lock: LockInfo): void {
  if (versionWarned || lock.version === VERSION) return;
  versionWarned = true;
  process.stderr.write(
    `hlao: supervisor ${lock.version} differs from CLI ${VERSION}; run "hlao down" and let the next command start ${VERSION}\n`,
  );
}
