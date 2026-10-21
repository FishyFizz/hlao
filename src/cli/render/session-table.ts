import type { SessionView } from "../../protocol.js";
import {
  agentLabel,
  busyFor,
  displayName,
  exitDetail,
  modelLabel,
} from "./session-fields.js";
import type { Style } from "./style.js";
import { styleStatus } from "./style.js";
import { fitTable, renderTable } from "./table.js";
import {
  formatAge,
  formatCreated,
  formatTokens,
  oneLine,
  truncateLeft,
  truncateRight,
} from "./text.js";

export const SESSION_FIELD_NAMES = [
  "self",
  "id",
  "name",
  "backend",
  "status",
  "turn",
  "queued",
  "activity",
  "created",
  "event",
  "busy",
  "requester",
  "model",
  "agent",
  "mode",
  "pending",
  "exit",
  "context",
  "cost",
  "cwd",
] as const;

export type SessionField = (typeof SESSION_FIELD_NAMES)[number];

export interface SessionTableOptions {
  wide?: boolean;
  tree?: boolean;
  usage?: boolean;
  /** Explicit column selection, in the caller's order. */
  fields?: SessionField[];
  /** Omit CWD from the default column set. */
  noCwd?: boolean;
  /** Terminal width to fit; omitted or 0 means no fitting (scripts keep full width). */
  width?: number;
}

const DEFAULT_DROP_ORDER: SessionField[] = [
  "self",
  "cwd",
  "created",
  "requester",
  "exit",
  "agent",
  "mode",
  "busy",
  "model",
  "event",
  "context",
  "cost",
  "pending",
];

const SHRINKABLE: SessionField[] = [
  "event",
  "pending",
  "agent",
  "requester",
  "model",
  "name",
  "cwd",
];

const FIELD_HEADERS: Record<SessionField, string> = {
  self: "SELF",
  id: "ID",
  name: "NAME",
  backend: "BACKEND",
  status: "STATUS",
  turn: "TURN",
  queued: "QUEUED",
  activity: "ACTIVITY",
  created: "CREATED",
  event: "EVENT",
  busy: "BUSY",
  requester: "REQUESTER",
  model: "MODEL",
  agent: "AGENT",
  mode: "MODE",
  pending: "PENDING",
  exit: "EXIT",
  context: "CONTEXT",
  cost: "COST",
  cwd: "CWD",
};

export function renderSessionTable(
  sessions: SessionView[],
  style: Style,
  selfId: string | null = null,
  options: SessionTableOptions = {},
): string {
  if (sessions.length === 0) return style.dim("no sessions");
  const showSelf = selfId !== null;

  let fields: SessionField[];
  if (options.fields !== undefined && options.fields.length > 0) {
    fields = [...new Set(options.fields)].filter(
      (field) => field !== "self" || showSelf,
    );
    // `--fields self` outside a session would otherwise render no columns.
    if (fields.length === 0) fields = ["id"];
  } else {
    fields = [
      ...(showSelf ? (["self"] as const) : []),
      "id",
      "name",
      "backend",
      "status",
      "turn",
      "queued",
      "activity",
      ...(options.wide
        ? ([
            "created",
            "event",
            "busy",
            "requester",
            "model",
            "agent",
            "mode",
            "pending",
            "exit",
          ] as const)
        : []),
      ...(options.usage ? (["context", "cost"] as const) : []),
      ...(!options.noCwd ? (["cwd"] as const) : []),
    ];
  }

  const rows = sessions.map((session) => {
    const indent = options.tree
      ? `${"  ".repeat(session.depth)}${session.depth > 0 ? "└ " : ""}`
      : "";
    const values: Record<SessionField, string> = {
      self: session.id === selfId ? "*" : "",
      id: `${indent}${session.id}`,
      name: displayName(session, style),
      backend: session.backend,
      status: styleStatus(
        session.status === "idle" && session.queued > 0
          ? "busy"
          : session.status,
        style,
      ),
      turn: String(session.turn),
      queued: session.queued > 0 ? String(session.queued) : "—",
      activity: formatAge(session.lastActivityAt),
      created: formatCreated(session.createdAt),
      event: truncateRight(
        oneLine(
          session.lastEvent
            ? `${session.lastEvent.type}${session.lastEvent.title ? ` · ${session.lastEvent.title}` : ""}`
            : "—",
        ),
        40,
      ),
      busy: busyFor(session),
      requester: session.createdBy ? oneLine(session.createdBy) : "—",
      model: modelLabel(session),
      agent: agentLabel(session),
      mode: session.modes?.currentModeId ?? "—",
      pending:
        session.pendingPermissions.length > 0
          ? `${session.pendingPermissions.length > 1 ? `${session.pendingPermissions.length} · ` : ""}${truncateRight(
              oneLine(session.pendingPermissions[0]!.title),
              30,
            )}`
          : session.pendingElicitation
            ? truncateRight(`Q: ${oneLine(session.pendingElicitation.message)}`, 30)
            : "—",
      exit: exitDetail(session),
      context: session.usage
        ? `${formatTokens(session.usage.used)}/${formatTokens(session.usage.size)}`
        : "—",
      cost: session.usage?.cost
        ? `${(session.usage.cost.amount / 100).toFixed(2)} ${session.usage.cost.currency}`
        : "—",
      cwd: truncateLeft(oneLine(session.cwd), 60),
    };
    return fields.map((field) => values[field]);
  });

  const width = options.width !== undefined && options.width > 0 ? options.width : 0;
  const fitted =
    width > 0
      ? fitTable({
          columns: fields,
          rows,
          width,
          dropOrder: options.fields !== undefined ? [] : DEFAULT_DROP_ORDER,
          shrinkable: SHRINKABLE,
          headerOf: (field) => FIELD_HEADERS[field as SessionField],
        })
      : { columns: fields, rows };
  return renderTable(
    fitted.columns.map((field) => FIELD_HEADERS[field as SessionField]),
    fitted.rows,
    style,
  );
}
