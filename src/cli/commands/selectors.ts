import type { SupervisorConnection } from "../../client.js";
import type { ListResult, SessionView } from "../../protocol.js";
import { usageError } from "../args.js";
import type { CommandContext } from "../context.js";
import { displayStatus, resolveInList } from "./session-view.js";

export { displayStatus, isTerminal } from "./session-view.js";

/**
 * The selector grammar shared by close, wait, cancel, permit, and mode.
 * It is a client assembly over `sessions.list`; the supervisor has no notion
 * of a job or a subtree pointer (ADR 0007).
 */
export interface SelectorFlags {
  /** A job root. A child token is refused: resolving it would widen scope. */
  root?: string;
  /** A subtree root: the session and every descendant. */
  tree?: string;
  statuses?: string[];
  idle?: number;
  exceptSelf?: boolean;
}

export function selectorsUsed(flags: SelectorFlags): boolean {
  return (
    flags.root !== undefined ||
    flags.tree !== undefined ||
    flags.statuses !== undefined ||
    flags.idle !== undefined
  );
}

/**
 * Resolve `--root`. A child token silently selects the whole job, including
 * unrelated siblings and the caller, which is a footgun on close/mode/permit;
 * name the real root instead and use `--tree` for a narrower scope.
 */
export function resolveJobRoot(
  sessions: SessionView[],
  token: string,
): SessionView {
  const resolved = resolveInList(sessions, token);
  if (resolved.rootId !== resolved.id) {
    throw usageError(
      `--root expects the job root, but ${resolved.id} is in job ${resolved.rootId} — ` +
        `pass "--root ${resolved.rootId}" for the whole job or "--tree ${resolved.id}" for its subtree`,
    );
  }
  return resolved;
}

/**
 * The target session and every descendant. Closed intermediates are retained
 * for lineage, so a live grandchild is still reachable through a closed parent.
 */
export function collectSubtree(
  target: SessionView,
  sessions: SessionView[],
): SessionView[] {
  const allowed = new Set<string>([target.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (
        session.parentId !== null &&
        allowed.has(session.parentId) &&
        !allowed.has(session.id)
      ) {
        allowed.add(session.id);
        changed = true;
      }
    }
  }
  return sessions.filter((session) => allowed.has(session.id));
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
    const root = resolveJobRoot(list.sessions, flags.root);
    targets = targets.filter((session) => session.rootId === root.id);
  }
  if (flags.tree !== undefined) {
    const allowed = new Set(
      collectSubtree(resolveInList(list.sessions, flags.tree), list.sessions).map(
        (session) => session.id,
      ),
    );
    targets = targets.filter((session) => allowed.has(session.id));
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
