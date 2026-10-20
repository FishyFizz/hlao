

import { type SupervisorConnection } from "../../client.js";
import { configFingerprint } from "../../config.js";
import { toHlaoError } from "../../errors.js";

import { normalizeProtocolVersion, type HelloResult } from "../../protocol.js";
import { formatDuration } from "../../time.js";

import { booleanOption, expectPositionals, parseArgs } from "../args.js";
import { COMMON, connect, contextFrom, out, writeJson } from "../context.js";
import { helpRequested } from "../help.js";

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
  const protocol = normalizeProtocolVersion(hello.protocolVersion) ?? {
    major: 0,
    minor: 0,
  };
  out(
    ctx.style.dim(
      `protocol v${protocol.major}.${protocol.minor} · ${hello.capabilities?.length ?? 0} capabilities · ${conn.lock.endpoint}`,
    ),
  );
  if (hello.configError) out(ctx.style.red(`config error: ${hello.configError}`));
  if (hello.lastCrash && conn.started !== true) {
    out(
      ctx.style.red(
        `previous supervisor (pid ${hello.lastCrash.pid}) did not shut down cleanly; its live table and retained history were lost`,
      ),
    );
  }
  if (hello.configHash !== configFingerprint(ctx.home)) {
    out(ctx.style.yellow("config on disk differs from the supervisor; run: hlao reload"));
  }
  return 0;
}
