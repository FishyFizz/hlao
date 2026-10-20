import { HlaoError } from "../errors.js";
import type { Session } from "../session.js";

/**
 * Resolve a caller-supplied token: exact id, then a unique name, then a unique
 * id prefix. Ambiguity is reported with the same candidate shape everywhere.
 */
export function resolveSession(
  sessions: ReadonlyMap<string, Session>,
  token: string,
): Session {
  const all = [...sessions.values()];
  const exact = sessions.get(token);
  if (exact) return exact;

  const nameMatches = all.filter((session) => session.name === token);
  if (nameMatches.length === 1) return nameMatches[0]!;
  if (nameMatches.length > 1) {
    throw new HlaoError(
      "ambiguous_id",
      `session name "${token}" matches ${nameMatches.length} sessions`,
      { candidates: candidates(nameMatches) },
    );
  }

  const matches = all.filter((session) => session.id.startsWith(token));
  if (matches.length === 0) {
    throw new HlaoError("not_found", `no session matching "${token}"`);
  }
  if (matches.length > 1) {
    throw new HlaoError(
      "ambiguous_id",
      `session prefix "${token}" matches ${matches.length} sessions`,
      { candidates: candidates(matches) },
    );
  }
  return matches[0]!;
}

function candidates(sessions: Session[]): {
  id: string;
  name: string | null;
  status: string;
}[] {
  return sessions.map((session) => {
    const view = session.view();
    return { id: view.id, name: view.name, status: view.status };
  });
}
