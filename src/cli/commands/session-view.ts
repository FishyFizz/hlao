import { HlaoError } from "../../errors.js";
import { isTerminalStatus } from "../../protocol.js";
import type { SessionView } from "../../protocol.js";

/**
 * Client-side projections over a session view, shared by list, find, and the
 * selector assemblies. These do not change supervisor state.
 */

/** A session with a queued prompt is displayed as busy even between turns. */
export function displayStatus(session: SessionView): string {
  return session.status === "idle" && session.queued > 0
    ? "busy"
    : session.status;
}

export function isTerminal(session: SessionView): boolean {
  return isTerminalStatus(session.status);
}

/** Resolve an exact id, then a unique name, then a unique id prefix. */
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
