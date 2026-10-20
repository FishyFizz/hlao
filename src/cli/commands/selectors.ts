import type { SupervisorConnection } from "../../client.js";
import type { ListResult, SessionView } from "../../protocol.js";
import type { CommandContext } from "../context.js";
import { resolveInList } from "./list.js";

/**
 * The selector grammar shared by close, wait, cancel, permit, and policy.
 * It is a client assembly over `sessions.list`; the supervisor has no notion
 * of a job or a subtree pointer (ADR 0007).
 */
export interface SelectorFlags {
  root?: string;
  statuses?: string[];
  idle?: number;
  exceptSelf?: boolean;
}

export function selectorsUsed(flags: SelectorFlags): boolean {
  return (
    flags.root !== undefined ||
    flags.statuses !== undefined ||
    flags.idle !== undefined
  );
}

export function displayStatus(session: SessionView): string {
  return session.status === "idle" && session.queued > 0
    ? "busy"
    : session.status;
}

export function isTerminal(session: SessionView): boolean {
  return session.status === "closed" || session.status === "failed";
}

export async function selectSessions(
  conn: SupervisorConnection,
  ctx: CommandContext,
  flags: SelectorFlags,
): Promise<SessionView[]> {
  const list = await conn.request<ListResult>("sessions.list", {
    includeClosed: true,
  });
  let targets = list.sessions;

  if (flags.root !== undefined) {
    const root = resolveInList(list.sessions, flags.root);
    targets = targets.filter((session) => session.rootId === root.rootId);
  }
  if (flags.statuses !== undefined) {
    const allowed = new Set(flags.statuses);
    targets = targets.filter((session) => allowed.has(displayStatus(session)));
  }
  if (flags.idle !== undefined) {
    const now = Date.now();
    targets = targets.filter((session) => {
      if (!session.settled) return false;
      const last = Date.parse(session.lastActivityAt);
      return Number.isFinite(last) && now - last >= flags.idle!;
    });
  }
  if (flags.exceptSelf && ctx.callerSessionId !== null) {
    targets = targets.filter((session) => session.id !== ctx.callerSessionId);
  }

  return [...targets].sort(
    (left, right) =>
      right.depth - left.depth ||
      left.createdAt.localeCompare(right.createdAt),
  );
}
