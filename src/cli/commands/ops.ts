import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { connectSupervisor, type SupervisorConnection } from "../../client.js";
import {
  configFingerprint,
  loadConfig,
  mergeBackends,
  redactConfig,
  toAgentView,
} from "../../config.js";
import { HlaoError, toHlaoError } from "../../errors.js";
import { pidAlive, probeSupervisor, readLock, removeLock } from "../../lock.js";
import { configPath, logPath } from "../../paths.js";
import type {
  HelloResult,
  ReloadResult,
  SpawnResult,
} from "../../protocol.js";
import { formatDuration } from "../../time.js";
import { VERSION } from "../../version.js";
import {
  booleanOption,
  expectPositionals,
  numberOption,
  parseArgs,
  stringOption,
  usageError,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  out,
  sleepMs,
  writeJson,
  type CommandContext,
} from "../context.js";
import { helpRequested } from "../help.js";
import {
  renderAgentTable,
  renderDoctor,
  sanitize,
  type DoctorCheck,
} from "../render.js";

export async function cmdAgents(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "cwd", type: "path", valueName: "DIR" },
  ]);
  if (helpRequested(parsed, "agents")) return 0;
  expectPositionals(parsed, "agents", 0, 0);
  const ctx = contextFrom(parsed);
  // Local and non-mutating: `agents` never starts a supervisor.
  const loaded = loadConfig(ctx.home);
  if (loaded.error) throw loaded.error;
  const cwd = resolve(stringOption(parsed, "cwd") ?? process.cwd());
  const merged = mergeBackends(loaded.config.backends, cwd);
  const result = {
    agents: Object.values(merged)
      .map(toAgentView)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(renderAgentTable(result.agents, ctx.style));
  return 0;
}

export async function cmdStatus(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "start", type: "boolean" },
  ]);
  if (helpRequested(parsed, "status")) return 0;
  expectPositionals(parsed, "status", 0, 0);
  const ctx = contextFrom(parsed);
  const start = booleanOption(parsed, "start") === true;

  let conn: SupervisorConnection;
  try {
    conn = await connect(ctx, start);
  } catch (error) {
    const converted = toHlaoError(error);
    if (converted.code !== "supervisor_unavailable") throw converted;
    if (ctx.json) {
      writeJson({
        running: false,
        home: ctx.home,
        hint: start ? null : "hlao status --start",
      });
    } else {
      out(`not running · home ${ctx.home}`);
      if (!start) out(ctx.style.dim("start: hlao status --start"));
    }
    return 1;
  }

  const hello = await conn.request<HelloResult>("hello", {});
  const startedAt = Date.parse(hello.startedAt);
  const up = Number.isFinite(startedAt)
    ? formatDuration(Math.max(0, Date.now() - startedAt))
    : "unknown";
  if (ctx.json) {
    writeJson({
      running: true,
      home: ctx.home,
      endpoint: conn.lock.endpoint,
      ...hello,
    });
    return 0;
  }
  out(
    `running · pid ${hello.pid} · supervisor ${hello.version} · up ${up}` +
      ctx.style.dim(` · ${hello.sessions} live session${hello.sessions === 1 ? "" : "s"}`),
  );
  out(ctx.style.dim(`protocol v${hello.protocolVersion} · ${conn.lock.endpoint}`));
  if (hello.configError) out(ctx.style.red(`config error: ${hello.configError}`));
  if (hello.configHash !== configFingerprint(ctx.home)) {
    out(ctx.style.yellow("config on disk differs from the supervisor; run: hlao reload"));
  }
  return 0;
}

export async function cmdLogs(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "lines", short: "n", type: "number", valueName: "N" },
    { name: "follow", short: "f", type: "boolean" },
  ]);
  if (helpRequested(parsed, "logs")) return 0;
  expectPositionals(parsed, "logs", 0, 0);
  const ctx = contextFrom(parsed);
  const file = logPath(ctx.home);
  const requested = numberOption(parsed, "lines");
  if (requested !== undefined && requested < 0) {
    throw usageError("--lines must be zero or greater");
  }
  const follow = booleanOption(parsed, "follow") === true;
  const limit = requested ?? 50;

  let exists = existsSync(file);
  let content = "";
  if (exists) {
    try {
      content = readFileSync(file, "utf8");
    } catch (error) {
      throw new HlaoError(
        "internal",
        `cannot read ${file}: ${(error as Error).message}`,
      );
    }
  }
  const lines = splitLines(content);
  const initial = limit === 0 ? lines : lines.slice(-limit);
  if (ctx.json && !follow) {
    writeJson({ path: file, lines: initial });
  } else {
    emitLogLines(ctx, initial, file, exists);
  }
  if (!follow) return 0;

  if (!exists) {
    if (!ctx.json) out(ctx.style.dim(`waiting for ${file}…`));
    while (!existsSync(file)) await sleepMs(250);
    exists = true;
  }

  let offset = exists ? byteLength(content) : 0;
  for (;;) {
    await sleepMs(400);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size === offset) continue;
    let chunk: string;
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const handle = openSync(file, "r");
      try {
        readSync(handle, buffer, 0, length, offset);
      } finally {
        closeSync(handle);
      }
      chunk = buffer.toString("utf8");
    } catch {
      continue;
    }
    offset = size;
    emitLogLines(ctx, splitLines(chunk), file, true);
  }
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function emitLogLines(
  ctx: CommandContext,
  lines: string[],
  file: string,
  exists: boolean,
): void {
  if (ctx.json) {
    for (const line of lines) {
      process.stdout.write(`${JSON.stringify({ path: file, line })}\n`);
    }
    return;
  }
  if (lines.length === 0) {
    if (!exists) out(ctx.style.dim(`no supervisor log at ${file}`));
    return;
  }
  for (const line of lines) out(line);
}

export async function cmdConfig(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "config")) return 0;
  expectPositionals(parsed, "config", 1, 1);
  const sub = parsed.positionals[0]!;
  if (!["show", "path", "validate"].includes(sub)) {
    throw usageError(`unknown config subcommand "${sub}" (show, path, validate)`);
  }
  const ctx = contextFrom(parsed);
  const file = configPath(ctx.home);

  if (sub === "path") {
    if (ctx.json) writeJson({ path: file });
    else out(file);
    return 0;
  }

  const loaded = loadConfig(ctx.home);
  if (sub === "validate") {
    if (loaded.error) throw loaded.error;
    if (ctx.json) writeJson({ ok: true, path: file });
    else out(`config OK · ${existsSync(file) ? file : "no config.json — built-in defaults"}`);
    return 0;
  }

  const redacted = redactConfig(loaded.config);
  if (ctx.json) {
    writeJson({
      path: file,
      exists: existsSync(file),
      config: redacted,
      error: loaded.error
        ? { code: loaded.error.code, message: loaded.error.message }
        : null,
    });
    return 0;
  }

  out(`config ${file}${existsSync(file) ? "" : " (missing; defaults)"}`);
  if (loaded.error) out(ctx.style.red(`invalid: ${loaded.error.message}`));
  out(`  permissionPolicy   ${redacted.permissionPolicy}`);
  out(`  waitTimeoutMs      ${formatDuration(redacted.waitTimeoutMs)}`);
  out(`  sendWaitTimeoutMs  ${formatDuration(redacted.sendWaitTimeoutMs)}`);
  out(`  startupTimeoutMs   ${formatDuration(redacted.startupTimeoutMs)}`);
  out(`  maxEventsPerSession ${redacted.maxEventsPerSession}`);
  out(`  maxEventLogBytes   ${redacted.maxEventLogBytes}`);
  out(`  maxEventBytes      ${redacted.maxEventBytes}`);
  out(`  retainClosedMs     ${formatDuration(redacted.retainClosedMs)}`);
  out("");
  out(renderAgentTable(Object.values(redacted.backends).map(toAgentView), ctx.style));
  return 0;
}

export async function cmdReload(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "reload")) return 0;
  expectPositionals(parsed, "reload", 0, 0);
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const result = await conn.request<ReloadResult>("supervisor.reload", {});
  if (result.configError) {
    throw new HlaoError("config_invalid", result.configError, {
      configHash: result.configHash,
    });
  }
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    `config reloaded · new spawns use ${configPath(ctx.home)}; live sessions keep their settings`,
  );
  return 0;
}

export async function cmdDoctor(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "start", type: "boolean" },
    { name: "probe", type: "boolean" },
  ]);
  if (helpRequested(parsed, "doctor")) return 0;
  expectPositionals(parsed, "doctor", 0, 0);
  const ctx = contextFrom(parsed);
  const probe = booleanOption(parsed, "probe") === true;
  const start = booleanOption(parsed, "start") === true || probe;
  const checks: DoctorCheck[] = [];

  const nodeOk = nodeVersionAtLeast(22, 13, 0);
  checks.push({
    name: "node",
    status: nodeOk ? "ok" : "fail",
    detail: `v${process.versions.node}${nodeOk ? "" : " — HLAO needs >= 22.13"}`,
  });

  const homeExists = existsSync(ctx.home);
  let homeIsDirectory = false;
  try {
    homeIsDirectory = homeExists && statSync(ctx.home).isDirectory();
  } catch {
    homeIsDirectory = false;
  }
  checks.push({
    name: "home",
    status: !homeExists ? "warn" : homeIsDirectory ? "ok" : "fail",
    detail: !homeExists
      ? `${ctx.home} (will be created)`
      : homeIsDirectory
        ? ctx.home
        : `${ctx.home} is not a directory`,
  });

  const loaded = loadConfig(ctx.home);
  const configFile = configPath(ctx.home);
  checks.push({
    name: "config",
    status: loaded.error ? "fail" : existsSync(configFile) ? "ok" : "warn",
    detail: loaded.error
      ? loaded.error.message
      : existsSync(configFile)
        ? configFile
        : "no config.json — built-in backends only",
  });

  const logFile = logPath(ctx.home);
  const logExists = existsSync(logFile);
  let logSize = 0;
  try {
    logSize = logExists ? statSync(logFile).size : 0;
  } catch {
    logSize = 0;
  }
  checks.push({
    name: "log",
    status: logExists ? "ok" : "warn",
    detail: logExists
      ? `${logFile} (${formatBytes(logSize)})`
      : `${logFile} (not created yet)`,
  });

  let conn: SupervisorConnection | null = null;
  try {
    conn = await connect(ctx, start);
    checks.push({
      name: "supervisor",
      status: "ok",
      detail: `pid ${conn.lock.pid} · ${conn.lock.endpoint}`,
    });
  } catch (error) {
    const converted = toHlaoError(error);
    checks.push({
      name: "supervisor",
      status:
        !start && converted.code === "supervisor_unavailable" ? "warn" : "fail",
      detail:
        !start && converted.code === "supervisor_unavailable"
          ? `not running · installed · start with "hlao doctor --start" or any session command`
          : `${converted.message} · log: ${logPath(ctx.home)}`,
    });
  }

  if (conn) {
    const hello = await conn.request<HelloResult>("hello", {});
    checks.push({
      name: "wire",
      status: hello.protocolVersion === 1 ? "ok" : "fail",
      detail: `protocol v${hello.protocolVersion} · supervisor ${hello.version}`,
    });
    if (hello.version !== VERSION) {
      checks.push({
        name: "versions",
        status: "warn",
        detail: `CLI ${VERSION} · supervisor ${hello.version}`,
      });
    }
    if (hello.configError) {
      checks.push({ name: "config load", status: "fail", detail: hello.configError });
    }
    if (hello.configHash !== configFingerprint(ctx.home)) {
      checks.push({
        name: "config freshness",
        status: "warn",
        detail: "config on disk differs from the supervisor; run: hlao reload",
      });
    }
  }

  // Backend readiness is a local property of the manifest and PATH; checking it
  // must not require (or start) a supervisor.
  if (loaded.error) {
    checks.push({
      name: "backends",
      status: "fail",
      detail: `user config is invalid: ${loaded.error.message}`,
    });
  } else {
    try {
      const merged = mergeBackends(loaded.config.backends, process.cwd());
      const agents = Object.values(merged).map(toAgentView);
      const available = agents.filter((agent) => agent.available);
      const unavailable = agents.filter((agent) => !agent.available);
      checks.push({
        name: "backends",
        status: available.length > 0 ? "ok" : "fail",
        detail:
          `${available.length}/${agents.length} adapter command${agents.length === 1 ? "" : "s"} present` +
          (available.length > 0
            ? ` (${available.map((agent) => agent.name).join(", ")})`
            : "") +
          (available.length > 0 && !probe
            ? " · run with --probe to start each adapter"
            : ""),
      });
      for (const agent of unavailable) {
        checks.push({
          name: `backend ${agent.name}`,
          status: "warn",
          detail: agent.unavailableReason ?? "unavailable",
        });
      }
    } catch (error) {
      checks.push({
        name: "backends",
        status: "fail",
        detail: toHlaoError(error).message,
      });
    }
  }

  if (probe) {
    if (!conn) {
      checks.push({
        name: "probe",
        status: "fail",
        detail: "no supervisor is available to launch adapters",
      });
    } else if (loaded.error) {
      checks.push({
        name: "probe",
        status: "fail",
        detail: "cannot probe while the user config is invalid",
      });
    } else {
      const merged = mergeBackends(loaded.config.backends, process.cwd());
      const available = Object.values(merged)
        .map(toAgentView)
        .filter((agent) => agent.available);
      for (const agent of available) {
        let spawned: SpawnResult | null = null;
        try {
          const created = await conn.request<SpawnResult>(
            "sessions.spawn",
            { backend: agent.name, cwd: process.cwd() },
            { timeoutMs: 0 },
          );
          spawned = created;
          await conn.request("sessions.close", {
            sessionId: created.session.id,
            force: true,
          });
          checks.push({
            name: `probe ${agent.name}`,
            status: "ok",
            detail: `ACP initialize + session/new succeeded (${created.session.id} closed)`,
          });
        } catch (error) {
          checks.push({
            name: `probe ${agent.name}`,
            status: "fail",
            detail: toHlaoError(error).message,
          });
          if (spawned) {
            try {
              await conn.request("sessions.close", {
                sessionId: spawned.session.id,
                force: true,
              });
            } catch {
              // The session is already gone or the supervisor is stopping.
            }
          }
        }
      }
    }
  }

  const failed = checks.some((check) => check.status === "fail");
  if (ctx.json) {
    writeJson({ ok: !failed, checks });
    return failed ? 1 : 0;
  }
  out(renderDoctor(checks, ctx.style));
  return failed ? 1 : 0;
}

export async function cmdWhoami(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "whoami")) return 0;
  expectPositionals(parsed, "whoami", 0, 0);
  const ctx = contextFrom(parsed);
  const sessionId = ctx.callerSessionId;
  const depthRaw = process.env.HLAO_DEPTH;
  const depth = depthRaw !== undefined && /^\d+$/.test(depthRaw) ? Number(depthRaw) : null;
  const result = {
    role: sessionId === null ? ("operator" as const) : ("session" as const),
    sessionId,
    name: process.env.HLAO_NAME ?? null,
    parentId: process.env.HLAO_PARENT_ID ?? null,
    rootId: process.env.HLAO_ROOT_ID ?? null,
    depth,
    backend: process.env.HLAO_BACKEND ?? null,
    home: ctx.home,
  };

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  if (sessionId === null) {
    out(`operator · home ${ctx.home}`);
  } else {
    out(
      `session ${ctx.style.bold(sessionId)}` +
        (result.name ? ` (${sanitize(result.name)})` : "") +
        ` · parent ${result.parentId ?? "—"}` +
        ` · root ${result.rootId ?? "—"}` +
        (depth !== null ? ` · depth ${depth}` : "") +
        (result.backend ? ` · backend ${result.backend}` : ""),
    );
  }
  return 0;
}

export async function cmdDown(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [...COMMON, { name: "force", type: "boolean" }]);
  if (helpRequested(parsed, "down")) return 0;
  expectPositionals(parsed, "down", 0, 0);
  const ctx = contextFrom(parsed);
  const force = booleanOption(parsed, "force") ?? false;
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

  try {
    const conn = await connectSupervisor({
      home: ctx.home,
      cliPath: ctx.cliPath,
      callerSessionId: ctx.callerSessionId,
      autostart: false,
    });
    if (!ctx.json && ctx.callerSessionId === null) {
      const hello = await conn.request<HelloResult>("hello", {});
      if (hello.sessions > 0) {
        process.stderr.write(
          `hlao: stopping closes ${hello.sessions} live session${hello.sessions === 1 ? "" : "s"} and discards their in-memory history\n`,
        );
      }
    }
    const result = await conn.request<{ sessionsClosed: number }>(
      "supervisor.shutdown",
      { force },
    );
    if (!(await waitForLockRemoval(ctx.home, 10_000))) {
      throw new HlaoError(
        "timeout",
        "the supervisor accepted shutdown but its lock is still present",
      );
    }
    if (ctx.json) writeJson({ stopped: true, ...result });
    else
      out(
        `supervisor stopped (${result.sessionsClosed} session${result.sessionsClosed === 1 ? "" : "s"} closed)`,
      );
    return 0;
  } catch (error) {
    if (!force) throw error;
    if (ctx.callerSessionId !== null) throw error;

    // Never kill a pid we cannot verify. A stale lock can outlive a crash and
    // its pid can be reused by an unrelated process. A successful hello proves
    // the endpoint and token are this supervisor's; without it, remove only the
    // lock and leave whatever owns the pid alone.
    const verified = await probeSupervisor(lock, 750);
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
    if (ctx.json) writeJson({ stopped: true, forced: true, sessionsClosed: 0 });
    else out("supervisor killed; lock removed");
    return 0;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * `--json` and `--home` are documented as global, so they must work before the
 * command as well as after it. Leading globals are stripped and re-injected
 * into the command's own arguments.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function nodeVersionAtLeast(major: number, minor: number, patch: number): boolean {
  const [currentMajor = 0, currentMinor = 0, currentPatch = 0] = process.versions.node
    .split(".")
    .map((part) => Number(part));
  if (currentMajor !== major) return currentMajor > major;
  if (currentMinor !== minor) return currentMinor > minor;
  return currentPatch >= patch;
}

function waitForLockRemoval(home: string, timeoutMs: number): Promise<boolean> {
  return waitFor(() => readLock(home) === null, timeoutMs);
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) {
        resolvePromise(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolvePromise(false);
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

