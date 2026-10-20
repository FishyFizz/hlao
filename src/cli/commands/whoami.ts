

import { connectSupervisor } from "../../client.js";

import { type GetResult } from "../../protocol.js";

import { expectPositionals, parseArgs } from "../args.js";
import { COMMON, contextFrom, out, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";

export async function cmdWhoami(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "whoami")) return 0;
  expectPositionals(parsed, "whoami", 0, 0);
  const ctx = contextFrom(parsed);
  const sessionId = ctx.callerSessionId;
  const depthRaw = process.env.HLAO_DEPTH;
  const depth = depthRaw !== undefined && /^\d+$/.test(depthRaw) ? Number(depthRaw) : null;
  const envName = process.env.HLAO_NAME ?? null;

  // A live check, never an autostart: whoami must not create a supervisor.
  let live: boolean | null = null;
  let liveName: string | null = null;
  let nameStale = false;
  if (sessionId !== null) {
    try {
      const conn = await connectSupervisor({
        home: ctx.home,
        cliPath: ctx.cliPath,
        callerSessionId: sessionId,
        autostart: false,
      });
      const got = await conn.request<GetResult>("sessions.get", {
        sessionId,
      });
      live = true;
      liveName = got.session.name;
      nameStale = envName !== liveName;
    } catch {
      live = false;
    }
  }

  const result = {
    role: sessionId === null ? ("operator" as const) : ("session" as const),
    sessionId,
    name: envName,
    live,
    liveName,
    nameStale,
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
    return 0;
  }

  const shownName = live === true ? liveName : envName;
  out(
    `session ${ctx.style.bold(sessionId)}` +
      (shownName ? ` (${sanitize(shownName)})` : "") +
      ` · parent ${result.parentId ?? "—"}` +
      ` · root ${result.rootId ?? "—"}` +
      (depth !== null ? ` · depth ${depth}` : "") +
      (result.backend ? ` · backend ${result.backend}` : ""),
  );
  if (nameStale) {
    out(
      ctx.style.dim(
        `environment HLAO_NAME ${envName === null ? "is unset" : `"${sanitize(envName)}"`} but the live name is ${liveName === null ? "unset" : `"${sanitize(liveName)}"`}`,
      ),
    );
  }
  if (live === false) {
    out(
      ctx.style.dim(
        "session is not live in the supervisor; the HLAO_* environment is stale",
      ),
    );
  }
  return 0;
}
