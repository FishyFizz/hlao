import { existsSync, statSync } from "node:fs";

import { type SupervisorConnection } from "../../client.js";
import { configFingerprint, loadConfig, mergeBackends, toAgentView } from "../../config.js";
import { readCrashMarker } from "../../crash.js";
import { toHlaoError } from "../../errors.js";

import { configPath, logPath } from "../../paths.js";
import { normalizeProtocolVersion, WIRE_PROTOCOL_MAJOR, type HelloResult, type SpawnResult } from "../../protocol.js";

import { VERSION } from "../../version.js";
import { booleanOption, expectPositionals, parseArgs } from "../args.js";
import { COMMON, connect, contextFrom, out, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { renderDoctor, type DoctorCheck } from "../render.js";

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

  const crash = readCrashMarker(ctx.home);
  if (crash) {
    checks.push({
      name: "last crash",
      status: "warn",
      detail: `previous supervisor pid ${crash.pid} (started ${crash.startedAt}) did not stop cleanly; its live table and retained history were lost`,
    });
  }

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
    const protocol = normalizeProtocolVersion(hello.protocolVersion) ?? {
      major: 0,
      minor: 0,
    };
    checks.push({
      name: "wire",
      status: protocol.major === WIRE_PROTOCOL_MAJOR ? "ok" : "fail",
      detail: `protocol v${protocol.major}.${protocol.minor} · ${hello.capabilities?.length ?? 0} capabilities · supervisor ${hello.version}`,
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
