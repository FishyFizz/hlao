import { resolve } from "node:path";
import type { SupervisorConnection } from "../../client.js";
import { isPathWithin, pathKey } from "../../paths.js";
import { isTerminalStatus, type SessionView } from "../../protocol.js";
import { usageError } from "../args.js";
import { SESSION_FIELD_NAMES, type SessionField } from "../render.js";
import { displayStatus, resolveInList } from "./session-view.js";

export interface ListFilters {
  statuses?: string[];
  backend?: string;
  root?: string;
  /** The caller's root subtree, resolved from HLAO_ROOT_ID/HLAO_SESSION_ID. */
  mineRoot?: string;
  name?: string;
  pending?: boolean;
  /** Exact working-directory match, applied locally so counts stay instance-wide. */
  cwd?: string;
  cwdPrefix?: string;
}

export interface ListRender {
  wide: boolean;
  tree: boolean;
  usage: boolean;
  fields?: SessionField[];
  noCwd: boolean;
  compact: boolean;
  sort: "created" | "activity";
}

export function parseFields(raw: string | undefined): SessionField[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw usageError(`--fields needs at least one column (${SESSION_FIELD_NAMES.join(", ")})`);
  }
  const unknown = names.filter(
    (name) => !(SESSION_FIELD_NAMES as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    throw usageError(
      `unknown --fields ${unknown.join(", ")} — known columns: ${SESSION_FIELD_NAMES.join(", ")}`,
    );
  }
  return names as SessionField[];
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

export function filterSessions(
  sessions: SessionView[],
  filters: ListFilters,
): SessionView[] {
  let result = [...sessions];
  if (filters.statuses) {
    const allowed = new Set(filters.statuses);
    result = result.filter((session) => allowed.has(displayStatus(session)));
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
    result = result.filter(
      (session) =>
        session.pendingPermissions.length > 0 ||
        session.pendingElicitation !== null,
    );
  }
  if (filters.cwd !== undefined) {
    const cwd = pathKey(filters.cwd);
    result = result.filter((session) => pathKey(session.cwd) === cwd);
  }
  if (filters.cwdPrefix !== undefined) {
    const prefix = filters.cwdPrefix;
    result = result.filter((session) => isPathWithin(session.cwd, prefix));
  }
  if (filters.root !== undefined) {
    const root = resolveInList(sessions, filters.root);
    result = result.filter((session) => session.rootId === root.rootId);
  }
  if (filters.mineRoot !== undefined) {
    result = result.filter((session) => session.rootId === filters.mineRoot);
  }
  return result;
}

/**
 * `--mine` is the caller's root subtree. HLAO_ROOT_ID is the direct answer;
 * otherwise the caller's own session names the root. Neither is an autostart.
 */
export async function resolveMineRoot(
  conn: SupervisorConnection,
): Promise<string> {
  const root = process.env.HLAO_ROOT_ID?.trim();
  if (root) return root;
  const own = process.env.HLAO_SESSION_ID?.trim();
  if (!own) {
    throw usageError("list --mine needs HLAO_SESSION_ID or HLAO_ROOT_ID");
  }
  const got = await conn.request<{ session: SessionView }>("sessions.get", {
    sessionId: own,
  });
  return got.session.rootId;
}

export function sortSessions(
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

export function applyDisplayFilter(
  sessions: SessionView[],
  showClosed: boolean,
): SessionView[] {
  return showClosed
    ? sessions
    : sessions.filter((session) => session.status !== "closed");
}

export function hasFilters(filters: ListFilters): boolean {
  return (
    filters.statuses !== undefined ||
    filters.backend !== undefined ||
    filters.root !== undefined ||
    filters.mineRoot !== undefined ||
    filters.name !== undefined ||
    filters.pending === true ||
    filters.cwd !== undefined ||
    filters.cwdPrefix !== undefined
  );
}

export function instanceCounts(sessions: SessionView[]): {
  live: number;
  retained: number;
  total: number;
} {
  const live = sessions.filter(
    (session) => !isTerminalStatus(session.status),
  ).length;
  return { live, retained: sessions.length - live, total: sessions.length };
}

export function statusSummary(sessions: SessionView[]): string {
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

export function usageSummary(sessions: SessionView[]): string {
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

export function resolveOptionalPath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : resolve(value);
}
