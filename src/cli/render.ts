import { isTerminalStatus } from "../protocol.js";
import type {
  AgentView,
  ElicitationView,
  EventView,
  PermissionView,
  ProviderSessionsResult,
  ReadResult,
  SessionStatus,
  SessionView,
} from "../protocol.js";
import { formatDuration } from "../time.js";

export interface Style {
  enabled: boolean;
  bold(value: string): string;
  dim(value: string): string;
  red(value: string): string;
  green(value: string): string;
  yellow(value: string): string;
  magenta(value: string): string;
  cyan(value: string): string;
  gray(value: string): string;
}

export function createStyle(enabled: boolean): Style {
  const wrap = (code: string) => (value: string) =>
    enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    enabled,
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    gray: wrap("90"),
  };
}

export function colorsEnabled(json: boolean): boolean {
  return !json && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

export interface RenderOptions {
  verbose?: boolean;
  fullTimestamps?: boolean;
  /** The caller supplied type/turn/grep filters, so an empty page is "no match". */
  filtered?: boolean;
}

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
      ? fitSessionTable(fields, rows, width, options.fields !== undefined)
      : { fields, rows };
  return renderTable(
    fitted.fields.map((field) => FIELD_HEADERS[field]),
    fitted.rows,
    style,
  );
}

/** Drop optional columns, then shrink the widest text column, until the table fits. */
function fitSessionTable(
  fields: SessionField[],
  rows: string[][],
  width: number,
  explicit: boolean,
): { fields: SessionField[]; rows: string[][] } {
  let currentFields = [...fields];
  let currentRows = rows.map((row) => [...row]);

  const totalWidth = (): number => {
    const widths = currentFields.map((_, column) => {
      let columnWidth = displayWidth(FIELD_HEADERS[currentFields[column]!]);
      for (const row of currentRows) {
        columnWidth = Math.max(columnWidth, displayWidth(row[column] ?? ""));
      }
      return columnWidth;
    });
    return widths.reduce((sum, columnWidth) => sum + columnWidth, 0) +
      2 * Math.max(0, currentFields.length - 1);
  };

  if (!explicit) {
    for (const field of DEFAULT_DROP_ORDER) {
      if (totalWidth() <= width) break;
      const index = currentFields.indexOf(field);
      if (index === -1) continue;
      currentFields = currentFields.filter((_, column) => column !== index);
      currentRows = currentRows.map((row) => row.filter((_, column) => column !== index));
    }
  }

  // Shrink a flexible column that is still wider than its header. Keep the
  // shrink loop bounded so a pathological width cannot spin.
  for (let guard = 0; guard < 500 && totalWidth() > width; guard += 1) {
    let best = -1;
    let bestWidth = 0;
    for (let column = 0; column < currentFields.length; column += 1) {
      const field = currentFields[column]!;
      if (!SHRINKABLE.includes(field)) continue;
      // Shaving a cell that contains an ANSI escape would cut through it.
      if (currentRows.some((row) => (row[column] ?? "").includes("\u001b"))) {
        continue;
      }
      let columnWidth = displayWidth(FIELD_HEADERS[field]);
      for (const row of currentRows) {
        columnWidth = Math.max(columnWidth, displayWidth(row[column] ?? ""));
      }
      if (columnWidth > bestWidth && columnWidth > 8) {
        best = column;
        bestWidth = columnWidth;
      }
    }
    if (best === -1) break;
    const target = Math.max(8, bestWidth - (totalWidth() - width));
    currentRows = currentRows.map((row) => {
      const next = [...row];
      next[best] = truncateRight(next[best] ?? "", target);
      return next;
    });
  }

  return { fields: currentFields, rows: currentRows };
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatCreated(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 16).replace("T", " ")
    : "—";
}

function busyFor(session: SessionView): string {  if (
    !session.turnStartedAt ||
    (session.status !== "busy" && session.status !== "waiting_permission")
  ) {
    return "—";
  }
  const started = Date.parse(session.turnStartedAt);
  if (!Number.isFinite(started)) return "—";
  return formatDuration(Math.max(0, Date.now() - started));
}

function exitDetail(session: SessionView): string {
  if (!session.exit) return "—";
  return session.exit.signal
    ? `signal ${session.exit.signal}`
    : `exit ${session.exit.code ?? "?"}`;
}

/** The provider config option whose category is `model`, when advertised. */
function modelLabel(session: SessionView): string {
  const options = session.configOptions ?? [];
  const model =
    options.find((option) => option.category === "model") ??
    options.find((option) => option.id === "model");
  return model ? oneLine(String(model.currentValue)) : "—";
}

/** Provider agent identity as one compact cell. */
function agentLabel(session: SessionView): string {
  const name = session.agentName ? oneLine(session.agentName) : null;
  const version = session.agentVersion ? oneLine(session.agentVersion) : null;
  if (name === null) return "—";
  return version ? `${name}@${version}` : name;
}

/**
 * Operator names win. A provider title is a display-only fallback, marked dim
 * so it is not mistaken for an addressable name.
 */
function displayName(session: SessionView, style: Style): string {
  if (session.name) return oneLine(session.name);
  if (session.title) return style.dim(truncateRight(oneLine(session.title), 40));
  if (session.firstPrompt) {
    return style.dim(truncateRight(oneLine(session.firstPrompt), 40));
  }
  return "—";
}

function planLabel(session: SessionView): string {
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

function compactionLabel(session: SessionView): string {
  const compaction = session.compaction;
  if (!compaction) return "—";
  const detail = compaction.error ?? compaction.summary;
  return (
    compaction.status +
    (detail ? ` · ${truncateRight(oneLine(detail), 100)}` : "")
  );
}

export function renderSessionHeader(session: SessionView, style: Style): string {
  const terminal = isTerminalStatus(session.status);
  const parts = [
    style.bold(session.id),
    session.name
      ? style.cyan(oneLine(session.name))
      : session.title
        ? style.dim(oneLine(session.title))
        : session.firstPrompt
          ? style.dim(oneLine(session.firstPrompt))
          : null,
    session.backend,
    styleStatus(session.status, style),
  ].filter((part): part is string => part !== null);
  const details = [
    `cwd ${oneLine(session.cwd)}`,
    `turn ${session.turn}`,
    `seq ${session.lastSeq}`,
    session.queued > 0 ? `queued ${session.queued}` : null,
    session.modes ? `mode ${session.modes.currentModeId}` : null,
    session.createdBy ? `by ${oneLine(session.createdBy)}` : null,
    session.parentId ? `parent ${session.parentId}` : "root",
    session.depth > 0 ? `root ${session.rootId}` : null,
    terminal ? `ended ${session.endedAt ? formatAge(session.endedAt) : "?"}` : null,
    terminal
      ? session.exit
        ? session.exit.signal
          ? `signal ${session.exit.signal}`
          : `exit ${session.exit.code ?? "?"}`
        : "exit unknown"
      : session.processId
        ? `pid ${session.processId}`
        : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join("  ")}\n${style.dim(details.join(" · "))}`;
}

/**
 * `get`'s human projection: the state the command promises without reading
 * events. The one-line header remains available as `get --brief`.
 */
export function renderSessionState(
  session: SessionView,
  style: Style,
  commandPrefix = "hlao",
): string {
  const terminal = isTerminalStatus(session.status);
  const head = [
    style.bold(session.id),
    session.name
      ? style.cyan(oneLine(session.name))
      : session.title
        ? style.dim(oneLine(session.title))
        : session.firstPrompt
          ? style.dim(oneLine(session.firstPrompt))
          : null,
    session.backend,
    styleStatus(session.status, style),
  ]
    .filter((part): part is string => part !== null)
    .join("  ");

  const state = [
    session.settled ? "settled" : "not settled",
    `turn ${session.turn}`,
    `queued ${session.queued}`,
    session.lastStopReason ? `last stop ${session.lastStopReason}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const mode = session.modes
    ? `${session.modes.currentModeId} (${session.modes.availableModes.length} available)`
    : "—";
  const config = session.configOptions?.length
    ? session.configOptions
        .map((option) => `${option.id}=${String(option.currentValue)}`)
        .join(" · ")
    : "—";
  const usage = session.usage
    ? `${formatTokens(session.usage.used)}/${formatTokens(session.usage.size)} tokens` +
      (session.usage.cost
        ? ` · ${(session.usage.cost.amount / 100).toFixed(2)} ${session.usage.cost.currency}`
        : "") +
      ` (${formatAge(session.usage.at)})`
    : "—";
  const lineage = [
    `created by ${session.createdBy ? oneLine(session.createdBy) : "unknown"}`,
    session.parentId ? `parent ${session.parentId}` : "root",
    `root ${session.rootId}`,
    `depth ${session.depth}`,
  ].join(" · ");
  const pending = pendingInputLabel(session, commandPrefix);
  const exit = terminal
    ? session.exit
      ? session.exit.signal
        ? `signal ${session.exit.signal}`
        : `code ${session.exit.code ?? "?"}`
      : "unknown"
    : session.processId
      ? `pid ${session.processId}`
      : "—";

  return [
    head,
    style.dim(`state    ${state}`),
    style.dim(`title    ${session.title ? oneLine(session.title) : "—"}`),
    style.dim(`agent    ${agentLabel(session)}`),
    style.dim(`plan     ${planLabel(session)}`),
    style.dim(`compaction ${compactionLabel(session)}`),
    style.dim(`mode     ${mode}`),
    style.dim(`config   ${config}`),
    style.dim(`usage    ${usage}`),
    style.dim(`lineage  ${lineage}`),
    ...(session.forkedFrom
      ? [style.dim(`forked   ${oneLine(session.forkedFrom)}`)]
      : []),
    style.dim(
      `provider ${session.agentSessionId ? oneLine(session.agentSessionId) : "—"}` +
        (session.agentSessionId
          ? ` · resume with: ${commandPrefix} spawn ${session.backend} --resume ${session.agentSessionId} --cwd ${oneLine(session.cwd)}`
          : ""),
    ),
    style.dim(`pending  ${pending}`),
    style.dim(
      `exit     ${exit}${session.endedAt ? ` · ended ${formatAge(session.endedAt)}` : ""}`,
    ),
    style.dim(`cwd      ${oneLine(session.cwd)}`),
  ].join("\n");
}

/**
 * `get`'s one-line pending description. Multiple requests name the queue and
 * point at `--all-pending`; a single one names its request id.
 */
function pendingInputLabel(session: SessionView, commandPrefix: string): string {
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

export function renderReadResult(
  result: ReadResult,
  style: Style,
  commandPrefix = "hlao",
  options: RenderOptions = {},
): string {
  const lines: string[] = [renderSessionHeader(result.session, style)];
  const permissions = result.session.pendingPermissions;
  const question = result.session.pendingElicitation;

  for (const pending of permissions) {
    const hasRequest = result.events.some(
      (event) =>
        event.type === "permission.requested" &&
        event.data.requestId === pending.requestId,
    );
    lines.push("");
    if (hasRequest) {
      lines.push(
        style.dim(
          `pending permission: ${oneLine(pending.title)} — ${commandPrefix} permit ${result.session.id} --request ${oneLine(pending.requestId)} --allow`,
        ),
      );
    } else {
      lines.push(
        renderPermission(
          result.session.id,
          pending,
          style,
          commandPrefix,
          permissions.length > 1,
        ),
      );
    }
  }

  if (question) {
    const hasRequest = result.events.some(
      (event) =>
        event.type === "elicitation.requested" &&
        event.data.requestId === question.requestId,
    );
    lines.push("");
    if (hasRequest) {
      lines.push(
        style.dim(
          `pending question: ${oneLine(question.message)} — ${commandPrefix} elicit ${result.session.id}`,
        ),
      );
    } else {
      lines.push(
        renderElicitation(
          result.session.id,
          question,
          style,
          commandPrefix,
        ),
      );
    }
  }

  if (result.events.length === 0) {
    lines.push("");
    lines.push(
      style.dim(
        options.filtered
          ? `no matching events (last seq ${result.lastSeq})`
          : `no events (last seq ${result.lastSeq})`,
      ),
    );
  } else {
    lines.push("");
    lines.push(
      ...renderEvents(result.events, style, result.session.id, commandPrefix, options),
    );
  }

  if (result.truncated) {
    lines.push("");
    lines.push(
      style.yellow(
        `history starts at #${result.earliestRetainedSeq} — ${result.earliestRetainedSeq - 1} earlier events were evicted`,
      ),
    );
  }
  if (result.nextBefore !== null) {
    lines.push("");
    lines.push(
      style.dim(
        `older: ${commandPrefix} read ${result.session.id} --before ${result.nextBefore}`,
      ),
    );
  }
  if (result.hasMore) {
    lines.push("");
    lines.push(
      style.dim(
        `next: ${commandPrefix} read ${result.session.id} --since ${result.nextSeq}`,
      ),
    );
  }
  return lines.join("\n");
}

export function renderEvents(
  events: EventView[],
  style: Style,
  sessionId: string,
  commandPrefix = "hlao",
  options: RenderOptions = {},
): string[] {
  const verbose = options.verbose ?? false;
  const full = options.fullTimestamps ?? false;
  const lines: string[] = [];
  let agentText = "";
  let agentSeq = 0;
  let agentAt = "";
  let agentMessageId: string | null = null;
  let thoughtText = "";
  let thoughtSeq = 0;
  let thoughtAt = "";
  let hiddenStderr = 0;
  let firstHiddenStderr: number | null = null;
  let firstHiddenAt = "";
  let firstHiddenDay = false;
  let lastDay = "";
  let agentDay = false;
  let thoughtDay = false;
  let userText = "";
  let userSeq = 0;
  let userAt = "";
  let userMessageId: string | null = null;
  let userDay = false;
  let providerText = "";
  let providerSeq = 0;
  let providerAt = "";
  let providerMessageId: string | null = null;
  let providerSender: string | null = null;
  let providerDay = false;
  let compactionText = "";
  let compactionSeq = 0;
  let compactionAt = "";
  let compactionId: string | null = null;
  let compactionDay = false;

  const dayKey = (at: string): string => {
    const date = new Date(at);
    return Number.isFinite(date.getTime())
      ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
      : "";
  };
  /** True for the first event of a new local day (including the page's first). */
  const markDay = (at: string): boolean => {
    const key = dayKey(at);
    if (key === "" || key === lastDay) return false;
    lastDay = key;
    return true;
  };

  const flushAgent = (): void => {
    if (agentText.length > 0) {
      lines.push(`${cursor(agentSeq, agentAt, style, full, agentDay)}${style.cyan("agent")} › ${indent(agentText)}`);
      agentText = "";
      agentMessageId = null;
      agentDay = false;
    }
  };
  const flushThought = (): void => {
    if (thoughtText.length > 0) {
      lines.push(`${cursor(thoughtSeq, thoughtAt, style, full, thoughtDay)}${style.dim("thinking")} › ${style.dim(indent(thoughtText))}`);
      thoughtText = "";
      thoughtDay = false;
    }
  };
  const flushUser = (): void => {
    if (userText.length > 0) {
      lines.push(`${cursor(userSeq, userAt, style, full, userDay)}${style.bold("user")} › ${indent(userText)}`);
      userText = "";
      userMessageId = null;
      userDay = false;
    }
  };
  const flushProvider = (): void => {
    if (providerText.length > 0) {
      const who = providerSender ? `from ${providerSender}` : "message";
      lines.push(`${cursor(providerSeq, providerAt, style, full, providerDay)}${style.bold(who)} › ${indent(providerText)}`);
      providerText = "";
      providerMessageId = null;
      providerSender = null;
      providerDay = false;
    }
  };
  const flushCompaction = (): void => {
    if (compactionText.length > 0) {
      lines.push(`${cursor(compactionSeq, compactionAt, style, full, compactionDay)}${style.magenta("compaction")} › ${indent(compactionText)}`);
      compactionText = "";
      compactionId = null;
      compactionDay = false;
    }
  };
  const flush = (): void => {
    flushAgent();
    flushThought();
    flushUser();
    flushProvider();
    flushCompaction();
  };

  let replayState = false;
  for (const event of events) {
    const data = event.data;
    const dayChanged = markDay(event.at);
    const replay = event.replay === true;
    if (replay !== replayState) {
      flush();
      lines.push(
        style.dim(
          replay
            ? "— history restored from the provider —"
            : "— live —",
        ),
      );
      replayState = replay;
    }
    switch (event.type) {
      case "agent.message": {
        flushThought();
        flushUser();
        flushProvider();
        flushCompaction();
        const messageId = typeof data.messageId === "string" ? data.messageId : null;
        if (agentMessageId !== null && messageId !== null && messageId !== agentMessageId) {
          flushAgent();
        }
        if (agentText.length === 0) {
          agentSeq = event.seq;
          agentAt = event.at;
          agentDay = dayChanged;
        }
        if (messageId !== null) agentMessageId = messageId;
        agentText += typeof data.text === "string" ? data.text : "";
        break;
      }
      case "agent.thought": {
        flushAgent();
        flushUser();
        flushProvider();
        flushCompaction();
        if (thoughtText.length === 0) {
          thoughtSeq = event.seq;
          thoughtAt = event.at;
          thoughtDay = dayChanged;
        }
        thoughtText += typeof data.text === "string" ? data.text : "";
        break;
      }
      case "user.message": {
        flushAgent();
        flushThought();
        flushProvider();
        flushCompaction();
        const messageId = typeof data.messageId === "string" ? data.messageId : null;
        if (userMessageId !== null && messageId !== null && messageId !== userMessageId) {
          flushUser();
        }
        if (userText.length === 0) {
          userSeq = event.seq;
          userAt = event.at;
          userDay = dayChanged;
        }
        if (messageId !== null) userMessageId = messageId;
        userText += typeof data.text === "string" ? data.text : "";
        break;
      }
      case "session.message": {
        flushAgent();
        flushThought();
        flushUser();
        flushCompaction();
        const messageId = typeof data.messageId === "string" ? data.messageId : null;
        if (
          providerMessageId !== null &&
          messageId !== null &&
          messageId !== providerMessageId
        ) {
          flushProvider();
        }
        if (providerText.length === 0) {
          providerSeq = event.seq;
          providerAt = event.at;
          providerDay = dayChanged;
        }
        if (messageId !== null) providerMessageId = messageId;
        if (typeof data.senderSessionId === "string") {
          providerSender = data.senderSessionId;
        }
        providerText +=
          typeof data.text === "string"
            ? data.text
            : typeof data.content === "string"
              ? data.content
              : "";
        break;
      }
      case "prompt.sent": {
        flush();
        const text = typeof data.text === "string" ? data.text : "";
        const from = actorName(data.from);
        const who =
          from === null ? "unknown" : from === "operator" ? "operator" : `from ${from}`;
        const id =
          typeof data.messageId === "string"
            ? ` (${oneLine(data.messageId)})`
            : "";
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.bold(who)}${style.dim(id)} › ${indent(text)}`,
        );
        break;
      }
      case "prompt.steered": {
        flush();
        const id =
          typeof data.messageId === "string" ? oneLine(data.messageId) : "msg-?";
        const from = actorName(data.from) ?? "unknown";
        const text = typeof data.text === "string" ? data.text : "";
        const turn =
          event.turn === null || event.turn === undefined
            ? ""
            : ` · turn ${event.turn}`;
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `steered ${id} · from ${from}${turn}`,
          )} › ${indent(text)}`,
        );
        break;
      }
      case "prompt.queued": {
        flush();
        const id =
          typeof data.messageId === "string" ? oneLine(data.messageId) : "msg-?";
        const from = actorName(data.from) ?? "unknown";
        const preview = eventPreview(data);
        const position =
          data.position === undefined ? "" : ` (position ${String(data.position)})`;
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `queued ${id} · from ${from}${preview ? ` · "${preview}"` : ""}${position}`,
          )}`,
        );
        break;
      }
      case "prompt.discarded": {
        flush();
        const id =
          typeof data.messageId === "string" ? oneLine(data.messageId) : "msg-?";
        const from = actorName(data.from) ?? "unknown";
        const preview = eventPreview(data);
        const reason = String(data.reason ?? "cancelled");
        const by = actorName(data.by);
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `discarded ${id} · from ${from}${preview ? ` · "${preview}"` : ""} (${reason}${by ? `; by ${by}` : ""})`,
          )}`,
        );
        break;
      }
      case "turn.started": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(`— turn ${String(data.turn ?? event.turn ?? "?")} —`)}`);
        break;
      }
      case "turn.ended": {
        flush();
        const stop = String(data.stopReason ?? "unknown");
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(`— turn ${String(data.turn ?? event.turn ?? "?")} ended: ${stop} —`)}`,
        );
        break;
      }
      case "tool.call": {
        flush();
        const title = oneLine(data.title ?? data.toolCallId ?? "tool");
        const kind = data.kind ? style.dim(` [${String(data.kind)}]`) : "";
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.yellow("tool")} › ${title}${kind}`);
        if (verbose) lines.push(...renderPayload(data.rawInput, style));
        break;
      }
      case "tool.update": {
        flush();
        const status = typeof data.status === "string" ? data.status : null;
        const finished = status === "completed" || status === "failed";
        const title = oneLine(data.title ?? data.toolCallId ?? "tool");
        // The real input often arrives here, not on tool.call. Render it even
        // while the status is still pending so --verbose can show the command.
        const input = verbose ? renderPayload(data.rawInput, style) : [];
        if (!finished && input.length === 0) break;
        const colour = status === "failed" ? style.red : style.dim;
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.yellow("tool")} › ${title}` +
            (finished ? ` ${colour(`→ ${status}`)}` : ""),
        );
        lines.push(...input);
        if (verbose) lines.push(...renderPayload(data.rawOutput, style));
        break;
      }
      case "permission.requested": {
        flush();
        const options = Array.isArray(data.options)
          ? (data.options as { optionId: string; name: string; kind: string }[])
          : [];
        const title = oneLine(data.title ?? "permission required");
        const requestId =
          typeof data.requestId === "string" ? oneLine(data.requestId) : null;
        const queuePosition =
          typeof data.queuePosition === "number" ? data.queuePosition : null;
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.magenta("permission needed")} › ${title}` +
            (queuePosition !== null && queuePosition > 1
              ? style.dim(` · queue ${queuePosition}`)
              : ""),
        );
        for (const option of options) {
          lines.push(
            `  ${style.dim(String(option.kind).padEnd(12))} ${oneLine(option.name)} ${style.dim(`(${oneLine(option.optionId)})`)}`,
          );
        }
        lines.push(
          `  ${style.dim(
            `answer: ${commandPrefix} permit ${sessionId}` +
              (requestId !== null ? ` --request ${requestId}` : "") +
              ` --allow`,
          )}`,
        );
        if (options.some((option) => option.kind === "allow_always")) {
          lines.push(
            `  ${style.dim(`always: ${commandPrefix} permit ${sessionId}` + (requestId !== null ? ` --request ${requestId}` : "") + ` --allow --always`)}`,
          );
        }
        if (options.some((option) => option.kind === "reject_always")) {
          lines.push(
            `  ${style.dim(`deny always: ${commandPrefix} permit ${sessionId}` + (requestId !== null ? ` --request ${requestId}` : "") + ` --deny --always`)}`,
          );
        }
        break;
      }
      case "permission.resolved": {
        flush();
        const answer = data.optionId === null ? "cancelled" : oneLine(data.optionId);
        const reason =
          typeof data.reason === "string" ? oneLine(data.reason) : null;
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.magenta("permission")} › ${answer} ${style.dim(`(${oneLine(data.by ?? "unknown")}${reason !== null ? ` · ${reason}` : ""})`)}`,
        );
        break;
      }
      case "session.created": {
        flush();
        const createdBy = actorName(data.createdBy);
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `session created · ${oneLine(data.backend ?? "")} · ${oneLine(data.cwd ?? "")}` +
              (createdBy ? ` · by ${createdBy}` : ""),
          )}`,
        );
        break;
      }
      case "session.renamed": {
        flush();
        const name = data.name === null || data.name === undefined ? "(cleared)" : oneLine(data.name);
        const by = actorName(data.by);
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `session renamed · ${name}` + (by ? ` (by ${by})` : ""),
          )}`,
        );
        break;
      }
      case "session.resumed": {
        flush();
        const id =
          typeof data.agentSessionId === "string"
            ? oneLine(data.agentSessionId)
            : "provider session";
        const count =
          typeof data.historyEvents === "number" ? data.historyEvents : null;
        const replayed =
          count === null
            ? ""
            : ` · ${count} event${count === 1 ? "" : "s"} replayed`;
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `resumed ${id}${replayed}`,
          )}`,
        );
        break;
      }
      case "session.forked": {
        flush();
        const id =
          typeof data.agentSessionId === "string"
            ? oneLine(data.agentSessionId)
            : "provider session";
        const from =
          typeof data.forkedFrom === "string"
            ? oneLine(data.forkedFrom)
            : "provider session";
        const count =
          typeof data.historyEvents === "number" ? data.historyEvents : null;
        const outcome =
          data.historyLoaded === false
            ? " · history not replayed"
            : count === null
              ? ""
              : ` · ${count} event${count === 1 ? "" : "s"} replayed`;
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `forked ${id} from ${from}${outcome}`,
          )}`,
        );
        break;
      }
      case "session.initialized": {
        flush();
        const name =
          typeof data.agentName === "string" ? oneLine(data.agentName) : "";
        const version =
          typeof data.agentVersion === "string"
            ? oneLine(data.agentVersion)
            : "";
        const agent = name ? ` · ${name}${version ? ` ${version}` : ""}` : "";
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `ACP session ready${agent}`,
          )}`,
        );
        break;
      }
      case "session.closed": {
        flush();
        const by = actorName(data.by);
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `session closed${by ? ` (by ${by})` : ""}`,
          )}`,
        );
        break;
      }
      case "session.failed": {
        flush();
        const by = actorName(data.by);
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.red(
            `session failed: ${oneLine(data.message ?? "unknown")}${by ? ` (by ${by})` : ""}`,
          )}`,
        );
        break;
      }
      case "cancel.requested": {
        flush();
        const by = actorName(data.by);
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
            `cancel requested${by ? ` (by ${by})` : ""}`,
          )}`,
        );
        break;
      }
      case "error": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.red(`error: ${oneLine(data.message ?? "unknown")}`)}`);
        break;
      }
      case "stderr": {
        flush();
        if (verbose) {
          lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(`stderr › ${oneLine(data.text)}`)}`);
        } else {
          hiddenStderr += 1;
          if (firstHiddenStderr === null) {
            firstHiddenStderr = event.seq;
            firstHiddenAt = event.at;
            firstHiddenDay = dayChanged;
          }
        }
        break;
      }
      case "notice": {
        flush();
        const severity =
          typeof data.severity === "string" ? data.severity.toLowerCase() : "info";
        const label =
          severity === "error"
            ? style.red("error")
            : severity === "warning"
              ? style.yellow("warning")
              : style.cyan("notice");
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${label} › ${oneLine(data.title ?? "")}${
            data.description ? style.dim(` — ${oneLine(data.description)}`) : ""
          }`,
        );
        break;
      }
      case "usage": {
        flush();
        const used = Number(data.used ?? 0);
        const size = Number(data.size ?? 0);
        const cost = data.cost as { amount?: number; currency?: string } | undefined;
        const costText =
          cost && typeof cost.amount === "number"
            ? ` · ${(cost.amount / 100).toFixed(2)} ${cost.currency ?? "USD"}`
            : "";
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(`usage › ${used}/${size} tokens${costText}`)}`,
        );
        break;
      }
      case "plan": {
        flush();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.cyan("plan")} › ${entries.length} entries`);
        for (const entry of entries.slice(0, 10)) {
          const item = entry as { status?: string; content?: string };
          lines.push(`  ${style.dim(`[${oneLine(item.status ?? "?")}]`)} ${oneLine(item.content ?? "")}`);
        }
        if (entries.length > 10) {
          lines.push(`  ${style.dim(`… ${entries.length - 10} more entries`)}`);
        }
        break;
      }
      case "mode": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(`mode › ${oneLine(data.currentModeId ?? "")}`)}`);
        break;
      }
      case "config": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim("config updated")}`);
        break;
      }
      case "commands": {
        flush();
        if (!verbose) break;
        const commands = Array.isArray(data.commands) ? data.commands.length : 0;
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(`commands › ${commands} available`)}`);
        break;
      }
      case "session.info": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(`session › ${oneLine(data.title ?? "")}`)}`);
        break;
      }
      case "plan.update": {
        flush();
        if (data.removed === true) {
          const id = typeof data.planId === "string" ? oneLine(data.planId) : "";
          lines.push(
            `${cursor(event.seq, event.at, style, full, dayChanged)}${style.cyan("plan")} › ${
              id ? `removed ${id}` : "removed"
            }`,
          );
          break;
        }
        const kind = typeof data.kind === "string" ? data.kind : null;
        if (kind === "items" && Array.isArray(data.entries)) {
          const entries = data.entries as {
            status?: string;
            content?: string;
          }[];
          const done = entries.filter((entry) => entry.status === "completed").length;
          const current =
            entries.find((entry) => entry.status === "in_progress") ??
            entries.find((entry) => entry.status === "pending");
          lines.push(
            `${cursor(event.seq, event.at, style, full, dayChanged)}${style.cyan("plan")} › ${done}/${entries.length} done` +
              (current
                ? style.dim(` · current: ${oneLine(current.content ?? "")}`)
                : ""),
          );
          break;
        }
        if (kind === "file") {
          lines.push(
            `${cursor(event.seq, event.at, style, full, dayChanged)}${style.cyan("plan")} › file ${oneLine(data.uri ?? "")}`,
          );
          break;
        }
        if (kind === "markdown") {
          lines.push(
            `${cursor(event.seq, event.at, style, full, dayChanged)}${style.cyan("plan")} › markdown ${style.dim(
              truncateRight(oneLine(data.content ?? ""), 100),
            )}`,
          );
          break;
        }
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.cyan("plan")} › updated`,
        );
        break;
      }
      case "compaction": {
        const id =
          typeof data.compactionId === "string" ? data.compactionId : null;
        const text = typeof data.text === "string" ? data.text : "";
        const chunk = data.chunk === true || text.length > 0;
        if (chunk) {
          flushAgent();
          flushThought();
          flushUser();
          flushProvider();
          if (compactionId !== null && id !== null && compactionId !== id) {
            flushCompaction();
          }
          if (compactionText.length === 0) {
            compactionSeq = event.seq;
            compactionAt = event.at;
            compactionDay = dayChanged;
          }
          if (id !== null) compactionId = id;
          compactionText += text;
          break;
        }
        flush();
        const status =
          typeof data.status === "string" ? oneLine(data.status) : "updated";
        const detail =
          typeof data.summary === "string"
            ? data.summary
            : typeof data.error === "string"
              ? `error: ${data.error}`
              : "";
        lines.push(
          `${cursor(event.seq, event.at, style, full, dayChanged)}${style.magenta("compaction")} › ${status}` +
            (detail
              ? style.dim(` · ${truncateRight(oneLine(detail), 120)}`)
              : ""),
        );
        break;
      }
      case "subagent": {
        flush();
        if (verbose) {
          lines.push(
            `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim("subagent")}`,
          );
        }
        break;
      }
      case "raw": {
        flush();
        const payload = data.raw;
        if (verbose && payload !== undefined) {
          let text: string;
          try {
            text =
              typeof payload === "string"
                ? payload
                : (JSON.stringify(payload) ?? String(payload));
          } catch {
            text = "[unserializable payload]";
          }
          lines.push(
            `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
              `raw › ${truncateRight(oneLine(text), 500)}`,
            )}`,
          );
        } else {
          lines.push(
            `${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(
              "raw — payload hidden; use --raw",
            )}`,
          );
        }
        break;
      }
      default: {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full, dayChanged)}${style.dim(event.type)}`);
        break;
      }
    }
  }

  flush();
  if (hiddenStderr > 0 && firstHiddenStderr !== null) {
    lines.push(
      `${cursor(firstHiddenStderr, firstHiddenAt, style, full, firstHiddenDay)}${style.dim(
        `${hiddenStderr} adapter diagnostic line${hiddenStderr === 1 ? "" : "s"} hidden (use --raw)`,
      )}`,
    );
  }
  return lines;
}

export function renderPermission(
  sessionId: string,
  permission: PermissionView,
  style: Style,
  commandPrefix = "hlao",
  multiple = false,
): string {
  const request =
    ` --request ${oneLine(permission.requestId)}`;
  const lines = [
    `${style.magenta("permission needed")} › ${oneLine(permission.title || "(untitled tool call)")}` +
      (multiple
        ? style.dim(` · ${oneLine(permission.requestId)}`)
        : ""),
  ];
  for (const option of permission.options) {
    lines.push(`  ${style.dim(option.kind.padEnd(12))} ${oneLine(option.name)} ${style.dim(`(${oneLine(option.optionId)})`)}`);
  }
  const allowed = permission.options.find(
    (option) => option.kind === "allow_once" || option.kind === "allow_always",
  );
  if (allowed) {
    lines.push(
      `  ${style.dim(`allow: ${commandPrefix} permit ${sessionId}${request} --allow`)}`,
    );
  }
  if (permission.options.some((option) => option.kind === "allow_always")) {
    lines.push(
      `  ${style.dim(`always: ${commandPrefix} permit ${sessionId}${request} --allow --always`)}`,
    );
  }
  if (permission.options.some((option) => option.kind === "reject_always")) {
    lines.push(
      `  ${style.dim(`deny always: ${commandPrefix} permit ${sessionId}${request} --deny --always`)}`,
    );
  }
  return lines.join("\n");
}

export function renderElicitation(
  sessionId: string,
  elicitation: ElicitationView,
  style: Style,
  commandPrefix = "hlao",
): string {
  const lines = [
    `${style.magenta("question")} › ${oneLine(elicitation.message || "(no message)")}`,
    style.dim(
      `request ${elicitation.requestId} · mode ${elicitation.mode}` +
        (elicitation.toolCallId ? ` · tool ${elicitation.toolCallId}` : "") +
        ` · requested ${elicitation.requestedAt}`,
    ),
  ];
  if (elicitation.mode === "url") {
    lines.push(`  ${style.dim("url:")} ${oneLine(elicitation.url ?? "—")}`);
  }
  const schema = elicitation.requestedSchema as
    | {
        properties?: Record<string, ElicitationSchemaProperty>;
        required?: string[];
      }
    | undefined;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  for (const [key, property] of Object.entries(properties)) {
    const kind = typeof property.type === "string" ? property.type : "string";
    const flags = required.has(key) ? `${kind}, required` : kind;
    lines.push(
      `  ${style.dim(flags.padEnd(16))} ${oneLine(key)}` +
        (property.title ? `: ${oneLine(property.title)}` : ""),
    );
    if (property.description) {
      lines.push(`    ${style.dim(oneLine(property.description))}`);
    }
    const options = elicitationOptions(property);
    if (options.length > 0) {
      lines.push(`    ${style.dim(`options: ${options.join(" | ")}`)}`);
    }
  }
  if (Object.keys(properties).length === 0 && elicitation.mode === "form") {
    lines.push(style.dim("  (no form fields)"));
  }
  lines.push(
    `  ${style.dim(`accept: ${commandPrefix} elicit ${sessionId} --accept key=value ...`)}`,
  );
  lines.push(
    `  ${style.dim(
      `decline: ${commandPrefix} elicit ${sessionId} --decline · ` +
        `cancel: ${commandPrefix} elicit ${sessionId} --cancel`,
    )}`,
  );
  return lines.join("\n");
}

interface ElicitationSchemaProperty {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  enum?: unknown[];
  oneOf?: { const?: unknown }[];
  anyOf?: { const?: unknown }[];
  items?: { enum?: unknown[] };
}

function elicitationOptions(property: ElicitationSchemaProperty): string[] {
  const values: unknown[] = [];
  if (Array.isArray(property.enum)) values.push(...property.enum);
  for (const branch of property.oneOf ?? []) {
    if (branch.const !== undefined) values.push(branch.const);
  }
  for (const branch of property.anyOf ?? []) {
    if (branch.const !== undefined) values.push(branch.const);
  }
  if (Array.isArray(property.items?.enum)) values.push(...property.items.enum);
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string"),
    ),
  ];
}

export function renderAgentTable(
  agents: AgentView[],
  style: Style,
  width?: number,
): string {
  if (agents.length === 0) return style.dim("no backends configured");
  let headers = ["NAME", "SOURCE", "READY", "MODE", "CONFIG", "COMMAND", "NOTES"];
  let rows = agents.map((agent) => {
    const commandLine = [agent.command, ...agent.args].join(" ");
    return [
      oneLine(agent.name),
      oneLine(agent.source),
      agent.available ? style.green("yes") : style.red("no"),
      agent.defaultMode ? oneLine(agent.defaultMode) : "—",
      agent.configPath ? truncateMiddle(oneLine(agent.configPath), 40) : "—",
      truncateMiddle(oneLine(commandLine), 60),
      agent.available ? oneLine(agent.description ?? "—") : style.red(oneLine(agent.unavailableReason ?? "unavailable")),
    ];
  });

  if (width !== undefined && width > 0) {
    const total = (): number => {
      const widths = headers.map((header, column) => {
        let value = displayWidth(header);
        for (const row of rows) {
          value = Math.max(value, displayWidth(row[column] ?? ""));
        }
        return value;
      });
      return widths.reduce((sum, value) => sum + value, 0) +
        2 * Math.max(0, headers.length - 1);
    };
    // NOTES, then CONFIG, then MODE, then COMMAND, then SOURCE.
    const droppable = ["NOTES", "CONFIG", "MODE", "COMMAND", "SOURCE"];
    while (total() > width && droppable.length > 0) {
      const name = droppable.shift()!;
      const index = headers.indexOf(name);
      if (index === -1) continue;
      headers = headers.filter((_, position) => position !== index);
      rows = rows.map((row) => row.filter((_, position) => position !== index));
    }
    for (let guard = 0; guard < 200 && total() > width; guard += 1) {
      const commandColumn = headers.indexOf("COMMAND");
      const configColumn = headers.indexOf("CONFIG");
      const shrink = commandColumn !== -1 ? commandColumn : configColumn;
      if (shrink === -1) break;
      const current = Math.max(
        displayWidth(headers[shrink]!),
        ...rows.map((row) => displayWidth(row[shrink] ?? "")),
      );
      if (current <= 8) break;
      const target = Math.max(8, current - (total() - width));
      rows = rows.map((row) => {
        const next = [...row];
        next[shrink] = truncateMiddle(next[shrink] ?? "", target);
        return next;
      });
    }
  }

  return renderTable(headers, rows, style);
}

export function renderProviderSessionTable(
  result: ProviderSessionsResult,
  style: Style,
  width?: number,
): string {
  const scope = result.cwd ? `cwd ${oneLine(result.cwd)}` : "all cwds";
  const heading =
    `${style.bold(result.backend)} provider sessions · ${scope}` +
    (result.agentName
      ? style.dim(
          ` · ${oneLine(result.agentName)}${result.agentVersion ? `@${oneLine(result.agentVersion)}` : ""}`,
        )
      : "");
  if (result.sessions.length === 0) {
    return `${heading}\n${style.dim("no provider sessions")}`;
  }

  let headers = ["SESSION ID", "UPDATED", "TITLE", "CWD", "HLAO"];
  let rows = result.sessions.map((row) => [
    oneLine(row.sessionId),
    row.updatedAt ? formatAge(row.updatedAt) : "—",
    row.title ? truncateRight(oneLine(row.title), 40) : "—",
    truncateMiddle(oneLine(row.cwd), 40),
    row.attached
      ? `${oneLine(row.hlaoSessionId ?? "?")}${
          row.hlaoName ? ` · ${oneLine(row.hlaoName)}` : ""
        }${row.hlaoStatus ? ` · ${row.hlaoStatus}` : ""}`
      : style.dim("provider-only"),
  ]);

  if (width !== undefined && width > 0) {
    const total = (): number => {
      const widths = headers.map((header, column) => {
        let value = displayWidth(header);
        for (const row of rows) {
          value = Math.max(value, displayWidth(row[column] ?? ""));
        }
        return value;
      });
      return (
        widths.reduce((sum, value) => sum + value, 0) +
        2 * Math.max(0, headers.length - 1)
      );
    };
    // Keep SESSION ID and HLAO at every width; drop the display-only columns.
    const droppable = ["TITLE", "CWD", "UPDATED"];
    while (total() > width && droppable.length > 0) {
      const name = droppable.shift()!;
      const index = headers.indexOf(name);
      if (index === -1) continue;
      headers = headers.filter((_, position) => position !== index);
      rows = rows.map((row) => row.filter((_, position) => position !== index));
    }
  }

  return (
    `${heading}\n${renderTable(headers, rows, style)}` +
    (result.nextCursor
      ? `\n${style.dim(`next cursor ${oneLine(result.nextCursor)}`)}`
      : "")
  );
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export function renderDoctor(checks: DoctorCheck[], style: Style): string {
  return checks
    .map((check) => {
      const mark =
        check.status === "ok"
          ? style.green("✓")
          : check.status === "warn"
            ? style.yellow("!")
            : style.red("✗");
      return `${mark} ${check.name}: ${check.detail}`;
    })
    .join("\n");
}

export function renderTable(
  headers: string[],
  rows: string[][],
  style: Style,
): string {
  const widths = headers.map((header, column) => {
    let width = header.length;
    for (const row of rows) {
      width = Math.max(width, visibleLength(row[column] ?? ""));
    }
    return width;
  });

  const headerLine = headers
    .map((header, column) => style.dim(pad(header, widths[column]!)))
    .join("  ");
  const body = rows
    .map((row) =>
      row
        .map((cell, column) => pad(cell ?? "", widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
  return `${headerLine}\n${body}`;
}

export function styleStatus(status: SessionStatus, style: Style): string {
  switch (status) {
    case "idle":
      return style.green(status);
    case "busy":
      return style.yellow(status);
    case "waiting_permission":
      return style.magenta(status);
    case "starting":
      return style.cyan(status);
    case "failed":
      return style.red(status);
    case "closed":
      return style.dim(status);
    default:
      return status;
  }
}

function formatAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const delta = Math.max(0, Date.now() - then);
  if (delta < 1_000) return "now";
  return `${formatDuration(delta)} ago`;
}

function cursor(
  seq: number,
  at: string,
  style: Style,
  full: boolean,
  dayChanged = false,
): string {
  const stamp = formatTimestamp(at, full, dayChanged);
  return style.gray(`#${String(seq).padEnd(4)} ${stamp ? `${stamp} ` : ""}`);
}

function formatTimestamp(at: string, full: boolean, dayChanged: boolean): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  if (full) return at;
  const day = dayChanged
    ? `${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate(),
      ).padStart(2, "0")} `
    : "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${day}${hh}:${mm}:${ss}`;
}

const ANSI_ESCAPE =
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// U+061C, U+200E/F, U+202A-E, U+2066-9: bidi overrides can reorder a terminal.
const BIDI_CHARS = /[؜‎‏‪-‮⁦-⁩]/g;

/** Agent-derived text is untrusted: never let it inject terminal control sequences. */
export function sanitize(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "");
}

function oneLine(value: unknown): string {
  return sanitize(String(value ?? ""))
    .replace(/[\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** The `from`/`by`/`createdBy` value exactly as the event carries it. */
function actorName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = oneLine(value);
  return name.length > 0 ? name : null;
}

const EVENT_PREVIEW_CHARS = 200;

/** A bounded, one-line preview from a prompt event, sanitized for the terminal. */
function eventPreview(data: Record<string, unknown>): string {
  const text =
    typeof data.textPreview === "string"
      ? data.textPreview
      : typeof data.text === "string"
        ? data.text
        : "";
  const line = oneLine(text);
  return line.length > EVENT_PREVIEW_CHARS
    ? `${line.slice(0, EVENT_PREVIEW_CHARS)}…`
    : line;
}

function indent(text: string): string {
  return sanitize(text).replace(/\n/g, "\n  ");
}

const PAYLOAD_PREVIEW_CHARS = 2_000;

function renderPayload(value: unknown, style: Style): string[] {
  if (value === undefined || value === null) return [];
  // An empty object/array/string is what several adapters send before the real
  // payload arrives; printing "{}" adds noise without information.
  if (
    (typeof value === "object" && value !== null && Object.keys(value).length === 0) ||
    value === ""
  ) {
    return [];
  }
  let text: string;
  try {
    text =
      typeof value === "string"
        ? value
        : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    text = "[unserializable payload]";
  }
  text = sanitize(text);
  if (text.length > PAYLOAD_PREVIEW_CHARS) {
    text = `${text.slice(0, PAYLOAD_PREVIEW_CHARS)}… [truncated]`;
  }
  return text.split("\n").map((line) => `  ${style.dim(line)}`);
}

function truncateLeft(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  return `…${takeWidth(value, Math.max(0, max - 1), true)}`;
}

function truncateRight(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  return `${takeWidth(value, Math.max(0, max - 1))}…`;
}

function truncateMiddle(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  const keep = Math.max(0, max - 1);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${takeWidth(value, head)}…${takeWidth(value, tail, true)}`;
}

function pad(value: string, width: number): string {
  const missing = width - visibleLength(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Columns occupied in a terminal: CJK and emoji are two, combining marks zero. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value.replace(ANSI_PATTERN, "")) {
    width += charWidth(char.codePointAt(0)!);
  }
  return width;
}

function visibleLength(value: string): number {
  return displayWidth(value);
}

function takeWidth(value: string, max: number, fromEnd = false): string {
  let out = "";
  let width = 0;
  const chars = [...value];
  if (fromEnd) chars.reverse();
  for (const char of chars) {
    const charColumns = charWidth(char.codePointAt(0)!);
    if (width + charColumns > max) break;
    out = fromEnd ? char + out : out + char;
    width += charColumns;
  }
  return out;
}

function charWidth(codePoint: number): number {
  // Combining marks and zero-width characters occupy no column.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfeff
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}
