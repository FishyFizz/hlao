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
  ensureCapability,
  out,
  sleepMs,
  writeJson,
  writeJsonLine,
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
  usage: boolean;
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
    { name: "usage", type: "boolean" },
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
    usage: booleanOption(parsed, "usage") === true,
    sort: sortOption ?? (ctx.json ? "created" : "activity"),
  };
  const showClosed =
    booleanOption(parsed, "all") === true ||
    render.tree ||
    (statuses?.includes("closed") ?? false);
  const cwd = resolveOptional(stringOption(parsed, "cwd"));
  // Always fetch the full table so counts and --root resolution see retained
  // sessions. What is displayed is decided locally.
  const params = {
    includeClosed: true,
    ...(cwd !== undefined ? { cwd } : {}),
  };

  const conn = await connect(ctx);
  if (render.usage) {
    await ensureCapability(conn, "session.usage", "list --usage");
  }
  if (booleanOption(parsed, "watch") === true) {
    const interval = numberOption(parsed, "interval") ?? 2_000;
    if (interval < 250) {
      throw usageError("--interval must be at least 250ms");
    }
    return await watchList(
      conn,
      ctx,
      params,
      filters,
      render,
      showClosed,
      interval,
    );
  }

  const result = await conn.request<ListResult>("sessions.list", params);
  const sessions = sortSessions(
    applyDisplayFilter(filterSessions(result.sessions, filters), showClosed),
    render.sort,
    render.tree,
  );
  const counts = instanceCounts(result.sessions);
  if (ctx.json) {
    writeJson({ sessions, counts });
    return 0;
  }
  if (sessions.length === 0) {
    printEmptyList(ctx, filters);
    out(
      listFooter(
        result.sessions,
        sessions,
        ctx,
        render.usage,
        hasFilters(filters),
      ),
    );
    return 0;
  }
  out(
    renderSessionTable(sessions, ctx.style, ctx.callerSessionId, {
      wide: render.wide,
      tree: render.tree,
      usage: render.usage,
    }),
  );
  out(
    listFooter(
      result.sessions,
      sessions,
      ctx,
      render.usage,
      hasFilters(filters),
    ),
  );
  return 0;
}

async function watchList(
  conn: SupervisorConnection,
  ctx: CommandContext,
  params: { includeClosed: boolean; cwd?: string },
  filters: ListFilters,
  render: ListRender,
  showClosed: boolean,
  interval: number,
): Promise<number> {
  let first = true;
  for (;;) {
    const result = await conn.request<ListResult>("sessions.list", params);
    const sessions = sortSessions(
      applyDisplayFilter(filterSessions(result.sessions, filters), showClosed),
      render.sort,
      render.tree,
    );
    if (ctx.json) {
      writeJsonLine({
        sessions,
        counts: instanceCounts(result.sessions),
      });
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
          usage: render.usage,
        }),
      );
      out(
        listFooter(
          result.sessions,
          sessions,
          ctx,
          render.usage,
          hasFilters(filters),
        ),
      );
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
    result = result.filter((session) =>
      allowed.has(
        session.status === "idle" && session.queued > 0
          ? "busy"
          : session.status,
      ),
    );
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

function isTerminal(session: SessionView): boolean {
  return session.status === "closed" || session.status === "failed";
}

function displayStatus(session: SessionView): string {
  return session.status === "idle" && session.queued > 0
    ? "busy"
    : session.status;
}

function applyDisplayFilter(
  sessions: SessionView[],
  showClosed: boolean,
): SessionView[] {
  return showClosed
    ? sessions
    : sessions.filter((session) => session.status !== "closed");
}

function hasFilters(filters: ListFilters): boolean {
  return (
    filters.statuses !== undefined ||
    filters.backend !== undefined ||
    filters.root !== undefined ||
    filters.name !== undefined ||
    filters.pending === true ||
    filters.cwdPrefix !== undefined
  );
}

function instanceCounts(sessions: SessionView[]): {
  live: number;
  retained: number;
  total: number;
} {
  const live = sessions.filter((session) => !isTerminal(session)).length;
  return { live, retained: sessions.length - live, total: sessions.length };
}

function statusSummary(sessions: SessionView[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const status = displayStatus(session);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order = [
    "busy",
    "waiting_permission",
    "idle",
    "starting",
    "failed",
    "closed",
  ];
  return order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${counts.get(status)} ${status}`)
    .join(" · ");
}

function listFooter(
  all: SessionView[],
  visible: SessionView[],
  ctx: CommandContext,
  usage: boolean,
  filtered: boolean,
): string {
  const counts = instanceCounts(all);
  const parts = [
    "instance",
    `${counts.live} live`,
    `${counts.retained} retained`,
  ];
  if (filtered) parts.push(`showing ${visible.length}`);
  const summary = statusSummary(visible);
  if (summary.length > 0) parts.push(summary);
  const usageLine = usage ? usageSummary(all) : null;
  if (usageLine !== null) parts.push(usageLine);
  return ctx.style.dim(parts.join(" · "));
}

function usageSummary(sessions: SessionView[]): string {
  const reported = sessions.filter((session) => session.usage !== null);
  if (reported.length === 0) return "cost: none reported";
  const costs = new Map<string, number>();
  for (const session of reported) {
    const cost = session.usage!.cost;
    if (cost) {
      costs.set(cost.currency, (costs.get(cost.currency) ?? 0) + cost.amount);
    }
  }
  // Tokens are per-session context-window snapshots, not additive usage.
  const costText =
    costs.size === 0
      ? "none reported"
      : [...costs.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([currency, amount]) => `${(amount / 100).toFixed(2)} ${currency}`)
          .join(" + ");
  return `cost: ${costText} · context: latest per session`;
}

function printEmptyList(
  ctx: CommandContext,
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
    out(ctx.style.dim('no sessions — hlao spawn <backend> "message"'));
  }
}

