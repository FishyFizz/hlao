import { resolve } from "node:path";
import { connectSupervisor } from "../../client.js";
import { HlaoError } from "../../errors.js";
import { pidAlive, probeSupervisor, readLock, removeLock } from "../../lock.js";
import { isTerminalStatus, type ListResult } from "../../protocol.js";
import {
  booleanOption,
  expectPositionals,
  parseArgs,
  stringOption,
} from "../args.js";
import { COMMON, contextFrom, out, waitFor, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";
import { exportAll } from "./exporting.js";

export async function cmdDown(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "force", type: "boolean" },
    { name: "dry-run", type: "boolean" },
    { name: "export", type: "path", valueName: "DIR" },
  ]);
  if (helpRequested(parsed, "down")) return 0;
  expectPositionals(parsed, "down", 0, 0);
  const ctx = contextFrom(parsed);
  const force = booleanOption(parsed, "force") ?? false;
  const dryRun = booleanOption(parsed, "dry-run") === true;
  const exportDir = stringOption(parsed, "export");
  const lock = readLock(ctx.home);

  if (!lock) {
    if (ctx.json) writeJson({ stopped: false, reason: "not_running" });
    else out("supervisor is not running");
    return 0;
  }
  if (!pidAlive(lock.pid)) {
    removeLock(ctx.home, lock.token);
    if (ctx.json) writeJson({ stopped: false, reason: "stale_lock_removed" });
    else out("removed a stale supervisor lock; nothing was running");
    return 0;
  }

  let retained = 0;
  try {
    const conn = await connectSupervisor({
      home: ctx.home,
      cliPath: ctx.cliPath,
      callerSessionId: ctx.callerSessionId,
      autostart: false,
      // `down` is the upgrade escape hatch: it may use the legacy connection
      // path to stop a live supervisor of an older major via the same
      // `sessions.list`/`supervisor.shutdown` methods. A normal command never
      // does this; it reports `version_mismatch` instead.
      allowLegacyProtocol: true,
    });

    // Retained terminal sessions hold the evidence a user needs after a crash.
    // Count both kinds before stopping so the warning and the result agree.
    const list = await conn.request<ListResult>("sessions.list", {
      includeClosed: true,
    });
    const live = list.sessions.filter(
      (session) => !isTerminalStatus(session.status),
    );
    const retainedSessions = list.sessions.filter(
      (session) => isTerminalStatus(session.status),
    );
    retained = retainedSessions.length;

    if (dryRun) {
      if (ctx.json) {
        writeJson({
          dryRun: true,
          live: live.length,
          retained,
          sessions: list.sessions,
          ...(exportDir !== undefined
            ? { exportDir: resolve(exportDir), exportCount: list.sessions.length }
            : {}),
        });
        return 0;
      }
      out(
        ctx.style.dim(
          `dry run; ${live.length} live · ${retained} retained` +
            (exportDir !== undefined
              ? ` · would export ${list.sessions.length} session${list.sessions.length === 1 ? "" : "s"} to ${exportDir}`
              : ""),
        ),
      );
      for (const session of list.sessions) {
        const action =
          isTerminalStatus(session.status)
            ? "discard history"
            : "close";
        out(`would ${action}: ${session.id}${session.name ? ` (${sanitize(session.name)})` : ""}`);
      }
      return 0;
    }

    if (!ctx.json && (live.length > 0 || retained > 0)) {
      const parts: string[] = [];
      if (live.length > 0) {
        parts.push(
          `closes ${live.length} live session${live.length === 1 ? "" : "s"} and discards ${
            live.length === 1 ? "its" : "their"
          } in-memory history`,
        );
      }
      if (retained > 0) {
        parts.push(
          `also discards ${retained} retained session histor${retained === 1 ? "y" : "ies"}`,
        );
      }
      process.stderr.write(
        `hlao: stopping ${parts.join("; ")} · run "hlao down --dry-run" to inspect\n`,
      );
    }

    let exported = 0;
    if (exportDir !== undefined) {
      const manifest = await exportAll(conn, resolve(exportDir), {
        raw: false,
        jsonl: false,
      });
      exported = manifest.sessions.length - manifest.failures;
      if (manifest.failures > 0) {
        throw new HlaoError(
          "internal",
          `export to ${exportDir} failed for ${manifest.failures} session${manifest.failures === 1 ? "" : "s"}; refusing to stop (see manifest.json)`,
        );
      }
      if (!ctx.json) {
        out(
          `exported ${exported} session${exported === 1 ? "" : "s"} to ${exportDir}`,
        );
      }
    }

    const result = await conn.request<{
      sessionsClosed: number;
      retainedDiscarded: number;
    }>("supervisor.shutdown", { force });
    if (!(await waitForLockRemoval(ctx.home, 10_000))) {
      throw new HlaoError(
        "timeout",
        "the supervisor accepted shutdown but its lock is still present",
      );
    }
    if (ctx.json) {
      writeJson({
        stopped: true,
        ...result,
        ...(exportDir !== undefined
          ? { exported, exportDir: resolve(exportDir) }
          : {}),
      });
    }
    else {
      out(
        `supervisor stopped (${result.sessionsClosed} session${result.sessionsClosed === 1 ? "" : "s"} closed` +
          (result.retainedDiscarded > 0
            ? `, ${result.retainedDiscarded} retained histor${result.retainedDiscarded === 1 ? "y" : "ies"} discarded`
            : "") +
          ")",
      );
    }
    return 0;
  } catch (error) {
    // An export is a safety promise; never fall through to a kill when it
    // could not run.
    if (exportDir !== undefined) throw error;
    if (!force) throw error;
    if (ctx.callerSessionId !== null) throw error;

    // Never kill a pid we cannot verify. A stale lock can outlive a crash and
    // its pid can be reused by an unrelated process. A successful hello proves
    // the endpoint and token are this supervisor's; without it, remove only the
    // lock and leave whatever owns the pid alone.
    const verified = (await probeSupervisor(lock, 750)).alive;
    if (!verified) {
      removeLock(ctx.home, lock.token);
      const stillRunning = pidAlive(lock.pid);
      if (ctx.json) {
        writeJson({
          stopped: false,
          staleLockRemoved: true,
          pidLeftRunning: stillRunning,
          ...(stillRunning ? { pid: lock.pid } : {}),
        });
      } else {
        out(
          stillRunning
            ? `removed a stale lock; pid ${lock.pid} was left running because it could not be verified as the HLAO supervisor`
            : "removed a stale lock; no supervisor was running",
        );
      }
      return 0;
    }

    try {
      process.kill(lock.pid);
    } catch {
      // Already gone.
    }
    const gone = await waitFor(() => !pidAlive(lock.pid), 5_000);
    if (!gone) {
      throw new HlaoError(
        "timeout",
        `supervisor pid ${lock.pid} did not exit after the kill`,
      );
    }
    removeLock(ctx.home, lock.token);
    if (ctx.json) {
      writeJson({
        stopped: true,
        forced: true,
        sessionsClosed: 0,
        retainedDiscarded: retained,
      });
    } else {
      out(
        "supervisor killed; lock removed" +
          (retained > 0
            ? ` (${retained} retained histor${retained === 1 ? "y" : "ies"} discarded)`
            : ""),
      );
    }
    return 0;
  }
}

function waitForLockRemoval(home: string, timeoutMs: number): Promise<boolean> {
  return waitFor(() => readLock(home) === null, timeoutMs);
}
