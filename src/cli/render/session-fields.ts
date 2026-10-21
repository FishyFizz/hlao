import type { SessionView } from "../../protocol.js";
import { formatDuration } from "../../time.js";
import type { Style } from "./style.js";
import { formatAge, oneLine, truncateRight } from "./text.js";

/** Elapsed time in the active turn, or "—" when no turn is running. */
export function busyFor(session: SessionView): string {
  if (
    !session.turnStartedAt ||
    (session.status !== "busy" && session.status !== "waiting_permission")
  ) {
    return "—";
  }
  const started = Date.parse(session.turnStartedAt);
  if (!Number.isFinite(started)) return "—";
  return formatDuration(Math.max(0, Date.now() - started));
}

export function exitDetail(session: SessionView): string {
  if (!session.exit) return "—";
  return session.exit.signal
    ? `signal ${session.exit.signal}`
    : `exit ${session.exit.code ?? "?"}`;
}

/** The provider config option whose category is `model`, when advertised. */
export function modelLabel(session: SessionView): string {
  const options = session.configOptions ?? [];
  const model =
    options.find((option) => option.category === "model") ??
    options.find((option) => option.id === "model");
  return model ? oneLine(String(model.currentValue)) : "—";
}

/** Provider agent identity as one compact cell. */
export function agentLabel(session: SessionView): string {
  const name = session.agentName ? oneLine(session.agentName) : null;
  const version = session.agentVersion ? oneLine(session.agentVersion) : null;
  if (name === null) return "—";
  return version ? `${name}@${version}` : name;
}

/**
 * Operator names win. A provider title is a display-only fallback, marked dim
 * so it is not mistaken for an addressable name.
 */
export function displayName(session: SessionView, style: Style): string {
  if (session.name) return oneLine(session.name);
  if (session.title) return style.dim(truncateRight(oneLine(session.title), 40));
  if (session.firstPrompt) {
    return style.dim(truncateRight(oneLine(session.firstPrompt), 40));
  }
  return "—";
}

export function planLabel(session: SessionView): string {
  const plan = session.plan;
  if (!plan) return "—";
  if (plan.kind === "items") {
    const entries = plan.entries ?? [];
    const done = entries.filter((entry) => entry.status === "completed").length;
    const current =
      entries.find((entry) => entry.status === "in_progress") ??
      entries.find((entry) => entry.status === "pending");
    return (
      `${done}/${entries.length} done` +
      (current ? ` · current: ${oneLine(current.content)}` : "")
    );
  }
  if (plan.kind === "file") return `file ${oneLine(plan.uri ?? "")}`;
  return `markdown · ${truncateRight(oneLine(plan.content ?? ""), 80)}`;
}

export function compactionLabel(session: SessionView): string {
  const compaction = session.compaction;
  if (!compaction) return "—";
  const detail = compaction.error ?? compaction.summary;
  return (
    compaction.status +
    (detail ? ` · ${truncateRight(oneLine(detail), 100)}` : "")
  );
}

/**
 * `get`'s one-line pending description. Multiple requests name the queue and
 * point at `--all-pending`; a single one names its request id.
 */
export function pendingInputLabel(
  session: SessionView,
  commandPrefix: string,
): string {
  const permissions = session.pendingPermissions;
  if (permissions.length === 1) {
    const pending = permissions[0]!;
    return `${oneLine(pending.title)} (requested ${formatAge(
      pending.requestedAt,
    )}) — ${commandPrefix} permit ${session.id} --request ${oneLine(
      pending.requestId,
    )} --allow`;
  }
  if (permissions.length > 1) {
    const titles = permissions
      .slice(0, 3)
      .map((pending) => oneLine(pending.title))
      .join("; ");
    const more =
      permissions.length > 3 ? `; +${permissions.length - 3} more` : "";
    return `${permissions.length} pending: ${titles}${more} — ${commandPrefix} permit ${session.id} --all-pending --allow`;
  }
  if (session.pendingElicitation) {
    return `question: ${oneLine(session.pendingElicitation.message)} (requested ${formatAge(
      session.pendingElicitation.requestedAt,
    )}) — ${commandPrefix} elicit ${session.id}`;
  }
  return "—";
}
