import type { SupervisorConnection } from "../../client.js";
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
import {
  applyDisplayFilter,
  filterSessions,
  hasFilters,
  instanceCounts,
  parseFields,
  parseStatuses,
  resolveMineRoot,
  resolveOptionalPath,
  sortSessions,
  statusSummary,
  usageSummary,
  type ListFilters,
  type ListRender,
} from "./list-filters.js";

export async function cmdList(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "all", short: "a", type: "boolean" },
    { name: "cwd", type: "path", valueName: "DIR" },
    { name: "cwd-prefix", type: "path", valueName: "DIR" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "backend", type: "string", valueName: "NAME" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "mine", type: "boolean" },
    { name: "name", type: "string", valueName: "TEXT" },
    { name: "pending", type: "boolean" },
    { name: "wide", type: "boolean" },
    { name: "tree", type: "boolean" },
    { name: "usage", type: "boolean" },
    { name: "fields", type: "string", valueName: "LIST" },
    { name: "no-cwd", type: "boolean" },
    { name: "compact", type: "boolean" },
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
    cwd: resolveOptionalPath(stringOption(parsed, "cwd")),
    cwdPrefix: resolveOptionalPath(stringOption(parsed, "cwd-prefix")),
  };
  const fields = parseFields(stringOption(parsed, "fields"));
  const compact = booleanOption(parsed, "compact") === true;
  if (fields !== undefined && ctx.json) {
    throw usageError("--fields selects human columns; use --compact for JSON");
  }
  if (compact && !ctx.json) {
    throw usageError("--compact requires --json or --watch --json");
  }
  const render: ListRender = {
    wide: booleanOption(parsed, "wide") === true,
    tree: booleanOption(parsed, "tree") === true,
    usage: booleanOption(parsed, "usage") === true,
    fields,
    noCwd: booleanOption(parsed, "no-cwd") === true,
    compact,
    sort: sortOption ?? (ctx.json ? "created" : "activity"),
  };
  const showClosed =
    booleanOption(parsed, "all") === true ||
    render.tree ||
    (statuses?.includes("closed") ?? false);
  // Always fetch the full table so counts and --root resolution see retained
  // sessions. What is displayed is decided locally.
  const params = {
    includeClosed: true,
  };

  const conn = await connect(ctx);
  if (booleanOption(parsed, "mine") === true) {
    filters.mineRoot = await resolveMineRoot(conn);
  }
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
    writeJson({ sessions: projectSessions(sessions, render.compact), counts });
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
      fields: render.fields,
      noCwd: render.noCwd,
      width: tableWidth(),
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
  params: { includeClosed: boolean },
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
        sessions: projectSessions(sessions, render.compact),
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
          fields: render.fields,
          noCwd: render.noCwd,
          width: tableWidth(),
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

/** Strip static, per-session provider options from list payloads. `get` keeps them. */
function projectSessions(
  sessions: SessionView[],
  compact: boolean,
): SessionView[] | Record<string, unknown>[] {
  if (!compact) return sessions;
  return sessions.map((session) => {
    const copy = { ...session } as Record<string, unknown>;
    delete copy.modes;
    delete copy.configOptions;
    return copy;
  });
}

function tableWidth(): number | undefined {
  return process.stdout.isTTY === true ? process.stdout.columns : undefined;
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

function printEmptyList(
  ctx: CommandContext,
  filters: ListFilters,
): void {
  if (hasFilters(filters)) {
    out(ctx.style.dim("no sessions match the filters"));
  } else {
    out(ctx.style.dim('no sessions — hlao spawn <backend> "message"'));
  }
}
