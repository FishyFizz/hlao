import { resolve } from "node:path";
import type { SupervisorConnection } from "../../client.js";
import { HlaoError } from "../../errors.js";
import type { ListResult, SessionView } from "../../protocol.js";
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
import { renderSessionTable } from "../render.js";

interface ListFilters {
  statuses?: string[];
  backend?: string;
  root?: string;
  name?: string;
  pending?: boolean;
  cwdPrefix?: string;
}

interface ListRender {
  wide: boolean;
  tree: boolean;
  sort: "created" | "activity";
}

export async function cmdList(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "all", short: "a", type: "boolean" },
    { name: "cwd", type: "path", valueName: "DIR" },
    { name: "cwd-prefix", type: "path", valueName: "DIR" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "backend", type: "string", valueName: "NAME" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "name", type: "string", valueName: "TEXT" },
    { name: "pending", type: "boolean" },
    { name: "wide", type: "boolean" },
    { name: "tree", type: "boolean" },
    { name: "sort", type: "string", valueName: "created|activity" },
    { name: "watch", type: "boolean" },
    { name: "interval", type: "duration", valueName: "DUR" },
  ]);
  if (helpRequested(parsed, "list")) return 0;
  expectPositionals(parsed, "list", 0, 0);

  const ctx = contextFrom(parsed);
  const statuses = parseStatuses(stringOption(parsed, "status"));
  const sortOption = stringOption(parsed, "sort");
  if (
    sortOption !== undefined &&
    sortOption !== "created" &&
    sortOption !== "activity"
  ) {
    throw usageError("--sort must be created or activity");
  }
  const filters: ListFilters = {
    statuses,
    backend: stringOption(parsed, "backend"),
    root: stringOption(parsed, "root"),
    name: stringOption(parsed, "name"),
    pending: booleanOption(parsed, "pending") === true,
    cwdPrefix: resolveOptional(stringOption(parsed, "cwd-prefix")),
  };
  const render: ListRender = {
    wide: booleanOption(parsed, "wide") === true,
    tree: booleanOption(parsed, "tree") === true,
    sort: sortOption ?? (ctx.json ? "created" : "activity"),
  };
  const cwd = resolveOptional(stringOption(parsed, "cwd"));
  const params = {
    includeClosed:
      (booleanOption(parsed, "all") ?? false) ||
      (statuses?.includes("closed") ?? false),
    ...(cwd !== undefined ? { cwd } : {}),
  };

  const conn = await connect(ctx);
  if (booleanOption(parsed, "watch") === true) {
    const interval = numberOption(parsed, "interval") ?? 2_000;
    if (interval < 250) {
      throw usageError("--interval must be at least 250ms");
    }
    return await watchList(conn, ctx, params, filters, render, interval);
  }

  const result = await conn.request<ListResult>("sessions.list", params);
  const sessions = sortSessions(
    filterSessions(result.sessions, filters),
    render.sort,
    render.tree,
  );
  if (ctx.json) {
    writeJson({ scope: result.scope, sessions });
    return 0;
  }
  if (sessions.length === 0) {
    printEmptyList(ctx, result, filters);
    return 0;
  }
  out(
    renderSessionTable(sessions, ctx.style, ctx.callerSessionId, {
      wide: render.wide,
      tree: render.tree,
    }),
  );
  out(listFooter(result, sessions.length, ctx));
  return 0;
}

async function watchList(
  conn: SupervisorConnection,
  ctx: CommandContext,
  params: { includeClosed: boolean; cwd?: string },
  filters: ListFilters,
  render: ListRender,
  interval: number,
): Promise<number> {
  let first = true;
  for (;;) {
    const result = await conn.request<ListResult>("sessions.list", params);
    const sessions = sortSessions(
      filterSessions(result.sessions, filters),
      render.sort,
      render.tree,
    );
    if (ctx.json) {
      process.stdout.write(
        `${JSON.stringify({ scope: result.scope, sessions })}\n`,
      );
    } else {
      if (!first) {
        if (process.stdout.isTTY === true) {
          process.stdout.write("\u001b[2J\u001b[H");
        } else {
          out("—");
        }
      }
      out(
        ctx.style.dim(
          `hlao list · ${new Date().toISOString()} · Ctrl-C to stop`,
        ),
      );
      out(
        renderSessionTable(sessions, ctx.style, ctx.callerSessionId, {
          wide: render.wide,
          tree: render.tree,
        }),
      );
      out(listFooter(result, sessions.length, ctx));
    }
    first = false;
    await sleepMs(interval);
  }
}

export function parseStatuses(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const allowed = [
    "starting",
    "idle",
    "busy",
    "waiting_permission",
    "closed",
    "failed",
  ];
  const statuses = raw
    .split(",")
    .map((status) => status.trim())
    .filter((status) => status.length > 0);
  if (statuses.length === 0) {
    throw usageError(`--status must list one of: ${allowed.join(", ")}`);
  }
  for (const status of statuses) {
    if (!allowed.includes(status)) {
      throw usageError(
        `unknown status "${status}" (${allowed.join(", ")})`,
      );
    }
  }
  return statuses;
}

function resolveOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : resolve(value);
}

function filterSessions(
  sessions: SessionView[],
  filters: ListFilters,
): SessionView[] {
  let result = [...sessions];
  if (filters.statuses) {
    const allowed = new Set(filters.statuses);
    result = result.filter((session) => allowed.has(session.status));
  }
  if (filters.backend !== undefined) {
    const backend = filters.backend.toLowerCase();
    result = result.filter(
      (session) => session.backend.toLowerCase() === backend,
    );
  }
  if (filters.name !== undefined) {
    const name = filters.name.toLowerCase();
    result = result.filter((session) =>
      (session.name ?? "").toLowerCase().includes(name),
    );
  }
  if (filters.pending === true) {
    result = result.filter((session) => session.pendingPermission !== null);
  }
  if (filters.cwdPrefix !== undefined) {
    const prefix = normalizePath(filters.cwdPrefix);
    result = result.filter((session) =>
      normalizePath(session.cwd).startsWith(prefix),
    );
  }
  if (filters.root !== undefined) {
    const root = resolveInList(sessions, filters.root);
    result = result.filter((session) => session.rootId === root.rootId);
  }
  return result;
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveInList(sessions: SessionView[], token: string): SessionView {
  const exact = sessions.find((session) => session.id === token);
  if (exact) return exact;
  const named = sessions.filter((session) => session.name === token);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw ambiguousSession(token, named);
  }
  const prefixed = sessions.filter((session) => session.id.startsWith(token));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) {
    throw ambiguousSession(`prefix "${token}"`, prefixed);
  }
  throw new HlaoError("not_found", `no session matching "${token}"`);
}

function ambiguousSession(
  what: string,
  sessions: SessionView[],
): HlaoError {
  return new HlaoError(
    "ambiguous_id",
    `session ${what} matches ${sessions.length} sessions`,
    {
      candidates: sessions.map((session) => ({
        id: session.id,
        name: session.name,
        status: session.status,
      })),
    },
  );
}

function sortSessions(
  sessions: SessionView[],
  sort: "created" | "activity",
  tree: boolean,
): SessionView[] {
  const sorted = [...sessions];
  if (tree) {
    sorted.sort(
      (left, right) =>
        left.rootId.localeCompare(right.rootId) ||
        left.depth - right.depth ||
        left.createdAt.localeCompare(right.createdAt),
    );
    return sorted;
  }
  if (sort === "activity") {
    sorted.sort(
      (left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        left.createdAt.localeCompare(right.createdAt),
    );
  }
  return sorted;
}

function listFooter(
  result: ListResult,
  visible: number,
  ctx: CommandContext,
): string {
  return ctx.style.dim(
    result.scope === "operator"
      ? `scope: operator · ${visible} visible`
      : `scope: self+descendants · ${visible} visible · siblings not shown`,
  );
}

function printEmptyList(
  ctx: CommandContext,
  result: ListResult,
  filters: ListFilters,
): void {
  const filtered =
    filters.statuses !== undefined ||
    filters.backend !== undefined ||
    filters.root !== undefined ||
    filters.name !== undefined ||
    filters.pending === true ||
    filters.cwdPrefix !== undefined;
  if (filtered) {
    out(ctx.style.dim("no sessions match the filters"));
  } else {
    out(
      ctx.style.dim(
        result.scope === "session"
          ? "no sessions in your scope"
          : 'no sessions — hlao spawn <backend> "message"',
      ),
    );
  }
  if (
    ctx.callerSessionId &&
    result.scope === "session" &&
    !result.sessions.some((session) => session.id === ctx.callerSessionId)
  ) {
    process.stderr.write(
      `hlao: HLAO_SESSION_ID=${ctx.callerSessionId} is not a live session; the scope is empty\n`,
    );
  }
}

