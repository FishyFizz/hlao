import { resolve } from "node:path";

import { HlaoError, toHlaoError } from "../../errors.js";
import type {
  ProviderSessionView,
  ProviderSessionsResult,
  SpawnResult,
} from "../../protocol.js";
import type { SupervisorConnection } from "../../client.js";
import {
  booleanOption,
  expectPositionals,
  parseArgs,
  stringOption,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  ensureCapability,
  hasCapability,
  out,
  sessionLabel,
  styleHint,
  withProgress,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";

/** Read the provider's catalog for a row, paging within a bounded scan. */
async function findProviderSession(
  conn: SupervisorConnection,
  backend: string,
  providerId: string,
  cwd: string | undefined,
): Promise<{ row: ProviderSessionView | null; error: string | null }> {
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    let result: ProviderSessionsResult;
    try {
      result = await conn.request<ProviderSessionsResult>(
        "backends.sessions",
        {
          backend,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(cursor !== null ? { cursor } : {}),
        },
        { timeoutMs: 0 },
      );
    } catch (error) {
      return { row: null, error: toHlaoError(error).message };
    }
    const row = result.sessions.find(
      (candidate) => candidate.sessionId === providerId,
    );
    if (row !== undefined) return { row, error: null };
    cursor = result.nextCursor;
    if (cursor === null) return { row: null, error: null };
  }
  return { row: null, error: null };
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Find the row without trusting a caller-supplied cwd. A scoped read is cheap
 * and catches the common case; when it misses, an unscoped read can reveal
 * that the session belongs to another directory (RF-05).
 */
async function lookupProviderRow(
  conn: SupervisorConnection,
  backend: string,
  providerId: string,
  cwd: string | undefined,
): Promise<{ row: ProviderSessionView | null; error: string | null }> {
  const scoped = await findProviderSession(conn, backend, providerId, cwd);
  if (scoped.row !== null || cwd === undefined) return scoped;
  const unscoped = await findProviderSession(
    conn,
    backend,
    providerId,
    undefined,
  );
  if (unscoped.row !== null) return unscoped;
  return scoped.error !== null && unscoped.error === null ? scoped : unscoped;
}

/**
 * Take an existing provider conversation into this HLAO instance as a new
 * HLAO session. This is a client assembly over the provider read and
 * `sessions.spawn`; it adds no durable mapping and restores no old identity.
 */
export async function cmdAdopt(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "cwd", type: "path", valueName: "DIR" },
    { name: "name", type: "string", valueName: "LABEL" },
    { name: "parent", type: "string", valueName: "SESSION" },
    { name: "no-skill", type: "boolean" },
    { name: "fork", type: "boolean" },
  ]);
  if (helpRequested(parsed, "adopt")) return 0;
  expectPositionals(parsed, "adopt", 2, 2);

  const backend = parsed.positionals[0]!;
  const providerId = parsed.positionals[1]!;
  const ctx = contextFrom(parsed);
  const fork = booleanOption(parsed, "fork") === true;
  const givenCwd = stringOption(parsed, "cwd");
  const conn = await connect(ctx);
  await ensureCapability(
    conn,
    fork ? "spawn.fork" : "spawn.resume",
    fork ? "adopt --fork" : "adopt",
  );

  const supportsCatalog = await hasCapability(conn, "backends.sessions");
  const lookup = supportsCatalog
    ? ctx.json
      ? await lookupProviderRow(
          conn,
          backend,
          providerId,
          givenCwd !== undefined ? resolve(givenCwd) : undefined,
        )
      : await withProgress(
          `looking up provider session ${providerId}`,
          lookupProviderRow(
            conn,
            backend,
            providerId,
            givenCwd !== undefined ? resolve(givenCwd) : undefined,
          ),
        )
    : { row: null, error: null };

  let cwd: string;
  if (lookup.row !== null) {
    const row = lookup.row;
    if (!fork && !row.loadable) {
      throw new HlaoError(
        "spawn_failed",
        `${backend} cannot adopt provider session ${providerId}: the adapter does not advertise ACP loadSession`,
      );
    }
    if (fork && !row.forkable) {
      throw new HlaoError(
        "spawn_failed",
        `${backend} cannot fork provider session ${providerId}: the adapter does not advertise ACP session/fork`,
      );
    }
    if (givenCwd !== undefined && !samePath(givenCwd, row.cwd)) {
      throw new HlaoError(
        "bad_request",
        `provider session ${providerId} belongs to ${row.cwd}, not ${resolve(givenCwd)}; omit --cwd to use the provider's cwd`,
      );
    }
    cwd = row.cwd;
  } else if (givenCwd !== undefined) {
    // The catalog can be unavailable, stale, or hide archived rows. An
    // explicit cwd is the caller's assertion that this is the right project.
    cwd = resolve(givenCwd);
  } else if (!supportsCatalog) {
    throw new HlaoError(
      "bad_request",
      `the running supervisor cannot list provider sessions; pass --cwd DIR to adopt ${providerId}`,
    );
  } else if (lookup.error !== null) {
    throw new HlaoError(
      "bad_request",
      `could not read ${backend}'s provider catalog (${lookup.error}); pass --cwd DIR to adopt ${providerId}`,
    );
  } else {
    throw new HlaoError(
      "not_found",
      `provider session ${providerId} was not found in the bounded scan of ${backend}'s catalog; check the id, or pass --cwd DIR to load it directly`,
    );
  }

  const result = await conn.request<SpawnResult>(
    "sessions.spawn",
    {
      backend,
      cwd,
      name: stringOption(parsed, "name"),
      parentSessionId: stringOption(parsed, "parent"),
      ...(booleanOption(parsed, "no-skill") === true ? { skill: false } : {}),
      ...(fork ? { forkSessionId: providerId } : { resumeSessionId: providerId }),
    },
    { timeoutMs: 0 },
  );

  if (ctx.json) {
    writeJson(result);
    return 0;
  }

  const session = result.session;
  const verb = result.duplicate
    ? fork
      ? "already forked, reusing"
      : "already attached, reusing"
    : fork
      ? "adopted copy"
      : "adopted";
  out(
    `${verb} ` +
      `${sessionLabel(ctx, session)} (${session.backend}) in ${session.cwd}` +
      (session.agentSessionId
        ? ctx.style.dim(`  provider ${sanitize(session.agentSessionId)}`)
        : "") +
      (session.forkedFrom
        ? ctx.style.dim(`  forked from ${sanitize(session.forkedFrom)}`)
        : "") +
      (session.parentId ? ctx.style.dim(`  parent ${session.parentId}`) : "") +
      (session.modes
        ? ctx.style.dim(`  mode ${sanitize(session.modes.currentModeId)}`)
        : ""),
  );
  if (result.duplicate) {
    out(
      ctx.style.dim(
        fork
          ? "this spawn request already produced the shown session; no second adapter was opened"
          : "this provider session is already live in this instance; no second adapter was opened",
      ),
    );
  } else {
    out(
      ctx.style.dim(
        "the provider history is restored; the interrupted turn is not replayed. Re-issue the prompt.",
      ),
    );
  }
  out(styleHint(ctx, `hlao read ${session.id} --since 0`));
  out(styleHint(ctx, `hlao send ${session.id} "<prompt>"`));
  return 0;
}
