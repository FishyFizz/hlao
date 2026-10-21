import type { SupervisorConnection } from "../../client.js";
import type { ListResult, ReadResult, SessionView } from "../../protocol.js";
import {
  expectPositionals,
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
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { formatTokens, renderTable } from "../render.js";
import { parseTimeBound, toIsoTimestamp } from "../time-args.js";
import { resolveInList } from "./session-view.js";

type Group = "session" | "root" | "model";

interface UsageRow {
  sessionId: string;
  name: string | null;
  rootId: string;
  backend: string;
  model: string | null;
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
  at: string;
}

/**
 * Fleet usage, projected from the snapshots sessions already carry. A time
 * window reads the latest `usage` event per session inside the window. Tokens
 * are context-window snapshots and are never summed; only cost is additive.
 */
export async function cmdUsage(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "since", type: "string", valueName: "TIME" },
    { name: "until", type: "string", valueName: "TIME" },
    { name: "group", type: "string", valueName: "session|root|model" },
  ]);
  if (helpRequested(parsed, "usage")) return 0;
  expectPositionals(parsed, "usage", 0, 0);

  const groupRaw = stringOption(parsed, "group") ?? "session";
  if (groupRaw !== "session" && groupRaw !== "root" && groupRaw !== "model") {
    throw usageError("--group must be session, root, or model");
  }
  const group: Group = groupRaw;
  const now = Date.now();
  const sinceRaw = stringOption(parsed, "since");
  const untilRaw = stringOption(parsed, "until");
  const since = sinceRaw === undefined ? undefined : parseTimeBound(sinceRaw, "--since", now);
  const until = untilRaw === undefined ? undefined : parseTimeBound(untilRaw, "--until", now);
  if (since !== undefined && until !== undefined && since >= until) {
    throw usageError("--since must be earlier than --until");
  }
  const sinceIso = since === undefined ? undefined : toIsoTimestamp(since);
  const untilIso = until === undefined ? undefined : toIsoTimestamp(until);

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const list = await conn.request<ListResult>("sessions.list", {
    includeClosed: true,
  });
  const rootToken = stringOption(parsed, "root");
  const rootId = rootToken === undefined ? undefined : resolveInList(list.sessions, rootToken).rootId;
  const sessions = list.sessions.filter(
    (session) => rootId === undefined || session.rootId === rootId,
  );

  const windowed = sinceIso !== undefined || untilIso !== undefined;
  if (windowed) {
    await ensureCapability(conn, "read.filters", "usage time window");
    await ensureCapability(conn, "read.time", "usage time window");
  }

  const rows: UsageRow[] = [];
  for (const session of sessions) {
    const row = windowed
      ? await readWindowUsage(conn, session, sinceIso, untilIso)
      : fromView(session);
    if (row !== null) rows.push(row);
  }

  const totals = costTotals(rows);
  if (ctx.json) {
    writeJson({
      generatedAt: new Date(now).toISOString(),
      group,
      window: { since: sinceIso ?? null, until: untilIso ?? null },
      rows: group === "session" ? rows : groupRows(rows, group),
      totals,
    });
    return 0;
  }

  if (rows.length === 0) {
    out(
      windowed
        ? "no usage reported in the requested window"
        : "no usage reported by any session",
    );
    return 0;
  }

  if (group === "session") {
    out(
      renderTable(
        ["ID", "NAME", "MODEL", "CONTEXT", "COST", "OBSERVED"],
        rows.map((row) => [
          row.sessionId,
          row.name ?? "—",
          row.model ?? "—",
          `${formatTokens(row.used)}/${formatTokens(row.size)}`,
          formatCost(row.cost),
          row.at,
        ]),
        ctx.style,
      ),
    );
  } else {
    const grouped = groupRows(rows, group);
    out(
      renderTable(
        [group.toUpperCase(), "SESSIONS", "COST"],
        grouped.map((row) => [row.key, String(row.sessions), row.cost]),
        ctx.style,
      ),
    );
  }
  out(
    ctx.style.dim(
      `cost is additive; context is a per-session snapshot${
        windowed ? " from the latest usage event in the window" : ""
      }`,
    ),
  );
  if (totals.length > 0) {
    out(
      ctx.style.dim(
        `total: ${totals
          .map(
            (total) =>
              `${(total.cost.amount / 100).toFixed(2)} ${total.cost.currency}`,
          )
          .join(" + ")}`,
      ),
    );
  }
  return 0;
}

function fromView(session: SessionView): UsageRow | null {
  const usage = session.usage;
  if (usage === null) return null;
  return {
    sessionId: session.id,
    name: displayNameOf(session),
    rootId: session.rootId,
    backend: session.backend,
    model: modelOf(session),
    used: usage.used,
    size: usage.size,
    cost: usage.cost,
    at: usage.at,
  };
}

/** The readable label a human expects: name, title, then first prompt. */
function displayNameOf(session: SessionView): string | null {
  const value = session.name ?? session.title ?? session.firstPrompt ?? null;
  if (value === null) return null;
  return value.length > 32 ? `${value.slice(0, 31)}…` : value;
}

async function readWindowUsage(
  conn: SupervisorConnection,
  session: SessionView,
  sinceIso: string | undefined,
  untilIso: string | undefined,
): Promise<UsageRow | null> {
  const page = await conn.request<ReadResult>("sessions.read", {
    sessionId: session.id,
    limit: 1,
    types: ["usage"],
    ...(sinceIso !== undefined ? { afterAt: sinceIso } : {}),
    ...(untilIso !== undefined ? { beforeAt: untilIso } : {}),
  });
  const event = page.events[page.events.length - 1];
  if (event === undefined) return null;
  const data = event.data;
  const rawCost = data.cost;
  let cost: UsageRow["cost"] = null;
  if (rawCost !== null && typeof rawCost === "object") {
    const record = rawCost as Record<string, unknown>;
    if (typeof record.amount === "number" && Number.isFinite(record.amount)) {
      cost = {
        amount: record.amount,
        currency: typeof record.currency === "string" ? record.currency : "USD",
      };
    }
  }
  return {
    sessionId: session.id,
    name: displayNameOf(session),
    rootId: session.rootId,
    backend: session.backend,
    model: modelOf(session),
    used: typeof data.used === "number" ? data.used : 0,
    size: typeof data.size === "number" ? data.size : 0,
    cost,
    at: event.at,
  };
}

function modelOf(session: SessionView): string | null {
  const options = session.configOptions ?? [];
  const model =
    options.find((option) => option.category === "model") ??
    options.find((option) => option.id === "model");
  return model ? String(model.currentValue) : null;
}

function costTotals(rows: UsageRow[]): { cost: { amount: number; currency: string } }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.cost === null) continue;
    totals.set(row.cost.currency, (totals.get(row.cost.currency) ?? 0) + row.cost.amount);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ cost: { amount, currency } }));
}

function groupRows(
  rows: UsageRow[],
  group: "root" | "model",
): { key: string; sessions: number; cost: string }[] {
  const grouped = new Map<string, { sessions: number; cost: Map<string, number> }>();
  for (const row of rows) {
    const key = group === "root" ? row.rootId : row.model ?? "(unknown)";
    const entry = grouped.get(key) ?? { sessions: 0, cost: new Map() };
    entry.sessions += 1;
    if (row.cost !== null) {
      entry.cost.set(
        row.cost.currency,
        (entry.cost.get(row.cost.currency) ?? 0) + row.cost.amount,
      );
    }
    grouped.set(key, entry);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => ({
      key,
      sessions: entry.sessions,
      cost:
        entry.cost.size === 0
          ? "—"
          : [...entry.cost.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([currency, amount]) => `${(amount / 100).toFixed(2)} ${currency}`)
              .join(" + "),
    }));
}

function formatCost(cost: UsageRow["cost"]): string {
  return cost === null ? "—" : `${(cost.amount / 100).toFixed(2)} ${cost.currency}`;
}
