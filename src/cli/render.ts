import type {
  AgentView,
  EventView,
  PermissionView,
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
}

export interface SessionTableOptions {
  wide?: boolean;
  tree?: boolean;
  usage?: boolean;
}

export function renderSessionTable(
  sessions: SessionView[],
  style: Style,
  selfId: string | null = null,
  options: SessionTableOptions = {},
): string {
  if (sessions.length === 0) return style.dim("no sessions");
  const showSelf = selfId !== null;
  const rows = sessions.map((session) => {
    const indent = options.tree
      ? `${"  ".repeat(session.depth)}${session.depth > 0 ? "└ " : ""}`
      : "";
    const base = [
      ...(showSelf ? [session.id === selfId ? "*" : ""] : []),
      `${indent}${session.id}`,
      oneLine(session.name ?? "—"),
      session.backend,
      styleStatus(
        session.status === "idle" && session.queued > 0
          ? "busy"
          : session.status,
        style,
      ),
      String(session.turn),
      session.queued > 0 ? String(session.queued) : "—",
      formatAge(session.lastActivityAt),
    ];
    if (options.wide) {
      base.push(
        busyFor(session),
        session.permissionPolicy,
        session.modes?.currentModeId ?? "—",
        session.pendingPermission
          ? truncateRight(oneLine(session.pendingPermission.title), 30)
          : "—",
        exitDetail(session),
      );
    }
    if (options.usage) {
      base.push(
        session.usage
          ? `${formatTokens(session.usage.used)}/${formatTokens(session.usage.size)}`
          : "—",
        session.usage?.cost
          ? `${(session.usage.cost.amount / 100).toFixed(2)} ${session.usage.cost.currency}`
          : "—",
      );
    }
    base.push(truncateLeft(oneLine(session.cwd), 60));
    return base;
  });
  return renderTable(
    [
      ...(showSelf ? ["SELF"] : []),
      "ID",
      "NAME",
      "BACKEND",
      "STATUS",
      "TURN",
      "QUEUED",
      "AGE",
      ...(options.wide ? ["BUSY", "POLICY", "MODE", "PENDING", "EXIT"] : []),
      ...(options.usage ? ["USAGE", "COST"] : []),
      "CWD",
    ],
    rows,
    style,
  );
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
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

export function renderSessionHeader(session: SessionView, style: Style): string {
  const terminal = session.status === "closed" || session.status === "failed";
  const parts = [
    style.bold(session.id),
    session.name ? style.cyan(oneLine(session.name)) : null,
    session.backend,
    styleStatus(session.status, style),
  ].filter((part): part is string => part !== null);
  const details = [
    `cwd ${oneLine(session.cwd)}`,
    `turn ${session.turn}`,
    `seq ${session.lastSeq}`,
    session.queued > 0 ? `queued ${session.queued}` : null,
    session.modes ? `mode ${session.modes.currentModeId}` : null,
    `policy ${session.permissionPolicy}`,
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

export function renderReadResult(
  result: ReadResult,
  style: Style,
  commandPrefix = "hlao",
  options: RenderOptions = {},
): string {
  const lines: string[] = [renderSessionHeader(result.session, style)];
  const pending = result.session.pendingPermission;

  if (pending) {
    const hasRequest = result.events.some(
      (event) =>
        event.type === "permission.requested" &&
        event.data.requestId === pending.requestId,
    );
    lines.push("");
    if (hasRequest) {
      lines.push(
        style.dim(
          `pending permission: ${oneLine(pending.title)} — ${commandPrefix} permit ${result.session.id} --allow`,
        ),
      );
    } else {
      lines.push(renderPermission(result.session.id, pending, style, commandPrefix));
    }
  }

  if (result.events.length === 0) {
    lines.push("");
    lines.push(style.dim(`no events (last seq ${result.lastSeq})`));
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

  const flushAgent = (): void => {
    if (agentText.length > 0) {
      lines.push(`${cursor(agentSeq, agentAt, style, full)}${style.cyan("agent")} › ${indent(agentText)}`);
      agentText = "";
      agentMessageId = null;
    }
  };
  const flushThought = (): void => {
    if (thoughtText.length > 0) {
      lines.push(`${cursor(thoughtSeq, thoughtAt, style, full)}${style.dim("thinking")} › ${style.dim(indent(thoughtText))}`);
      thoughtText = "";
    }
  };
  const flush = (): void => {
    flushAgent();
    flushThought();
  };

  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case "agent.message": {
        flushThought();
        const messageId = typeof data.messageId === "string" ? data.messageId : null;
        if (agentMessageId !== null && messageId !== null && messageId !== agentMessageId) {
          flushAgent();
        }
        if (agentText.length === 0) {
          agentSeq = event.seq;
          agentAt = event.at;
        }
        if (messageId !== null) agentMessageId = messageId;
        agentText += typeof data.text === "string" ? data.text : "";
        break;
      }
      case "agent.thought": {
        flushAgent();
        if (thoughtText.length === 0) {
          thoughtSeq = event.seq;
          thoughtAt = event.at;
        }
        thoughtText += typeof data.text === "string" ? data.text : "";
        break;
      }
      case "user.message":
        break;
      case "prompt.sent": {
        flush();
        const text = typeof data.text === "string" ? data.text : "";
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.bold("you")} › ${indent(text)}`);
        break;
      }
      case "prompt.queued": {
        flush();
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.dim(`queued message (position ${String(data.position ?? "?")})`)}`,
        );
        break;
      }
      case "prompt.discarded": {
        flush();
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.dim(`discarded a queued message (${String(data.reason ?? "cancelled")})`)}`,
        );
        break;
      }
      case "turn.started": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim(`— turn ${String(data.turn ?? event.turn ?? "?")} —`)}`);
        break;
      }
      case "turn.ended": {
        flush();
        const stop = String(data.stopReason ?? "unknown");
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.dim(`— turn ${String(data.turn ?? event.turn ?? "?")} ended: ${stop} —`)}`,
        );
        break;
      }
      case "tool.call": {
        flush();
        const title = oneLine(data.title ?? data.toolCallId ?? "tool");
        const kind = data.kind ? style.dim(` [${String(data.kind)}]`) : "";
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.yellow("tool")} › ${title}${kind}`);
        if (verbose) lines.push(...renderPayload(data.rawInput, style));
        break;
      }
      case "tool.update": {
        flush();
        const status = typeof data.status === "string" ? data.status : "updated";
        const title = oneLine(data.title ?? data.toolCallId ?? "tool");
        if (status !== "completed" && status !== "failed") break;
        const colour = status === "failed" ? style.red : style.dim;
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.yellow("tool")} › ${title} ${colour(`→ ${status}`)}`);
        if (verbose) lines.push(...renderPayload(data.rawOutput, style));
        break;
      }
      case "permission.requested": {
        flush();
        const options = Array.isArray(data.options)
          ? (data.options as { optionId: string; name: string; kind: string }[])
          : [];
        const title = oneLine(data.title ?? "permission required");
        if (data.auto === true) {
          lines.push(
            `${cursor(event.seq, event.at, style, full)}${style.magenta("permission")} › ${title} ${style.dim(`— auto-answered by policy:${String(data.policy ?? "allow")}`)}`,
          );
          break;
        }
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.magenta("permission needed")} › ${title}`,
        );
        for (const option of options) {
          lines.push(
            `  ${style.dim(String(option.kind).padEnd(12))} ${oneLine(option.name)} ${style.dim(`(${oneLine(option.optionId)})`)}`,
          );
        }
        lines.push(
          `  ${style.dim(`answer: ${commandPrefix} permit ${sessionId} --allow`)}`,
        );
        if (options.some((option) => option.kind === "allow_always")) {
          lines.push(
            `  ${style.dim(`stop future asks: ${commandPrefix} permit ${sessionId} --allow --always`)}`,
          );
        }
        break;
      }
      case "permission.resolved": {
        flush();
        const answer = data.optionId === null ? "cancelled" : oneLine(data.optionId);
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.magenta("permission")} › ${answer} ${style.dim(`(${oneLine(data.by ?? "unknown")})`)}`,
        );
        break;
      }
      case "policy.changed": {
        flush();
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.magenta("policy")} › ${oneLine(data.permissionPolicy ?? "")} ${style.dim(`(${oneLine(data.by ?? "unknown")})`)}`,
        );
        break;
      }
      case "session.created": {
        flush();
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.dim(`session created · ${oneLine(data.backend ?? "")} · ${oneLine(data.cwd ?? "")}`)}`,
        );
        break;
      }
      case "session.renamed": {
        flush();
        const name = data.name === null || data.name === undefined ? "(cleared)" : oneLine(data.name);
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.dim(`session renamed · ${name}`)}`,
        );
        break;
      }
      case "session.initialized": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim("ACP session ready")}`);
        break;
      }
      case "session.closed": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim("session closed")}`);
        break;
      }
      case "session.failed": {
        flush();
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.red(`session failed: ${oneLine(data.message ?? "unknown")}`)}`,
        );
        break;
      }
      case "cancel.requested": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim("cancel requested")}`);
        break;
      }
      case "error": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.red(`error: ${oneLine(data.message ?? "unknown")}`)}`);
        break;
      }
      case "stderr": {
        flush();
        if (verbose) {
          lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim(`stderr › ${String(data.text ?? "")}`)}`);
        } else {
          hiddenStderr += 1;
          if (firstHiddenStderr === null) {
            firstHiddenStderr = event.seq;
            firstHiddenAt = event.at;
          }
        }
        break;
      }
      case "notice": {
        flush();
        lines.push(
          `${cursor(event.seq, event.at, style, full)}${style.cyan("notice")} › ${oneLine(data.title ?? "")}${
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
          `${cursor(event.seq, event.at, style, full)}${style.dim(`usage › ${used}/${size} tokens${costText}`)}`,
        );
        break;
      }
      case "plan": {
        flush();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.cyan("plan")} › ${entries.length} entries`);
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
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim(`mode › ${oneLine(data.currentModeId ?? "")}`)}`);
        break;
      }
      case "config": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim("config updated")}`);
        break;
      }
      case "commands": {
        flush();
        if (!verbose) break;
        const commands = Array.isArray(data.commands) ? data.commands.length : 0;
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim(`commands › ${commands} available`)}`);
        break;
      }
      case "session.info": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim(`session › ${oneLine(data.title ?? "")}`)}`);
        break;
      }
      case "plan.update":
      case "compaction":
      case "subagent":
      case "raw": {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim(event.type)}`);
        break;
      }
      default: {
        flush();
        lines.push(`${cursor(event.seq, event.at, style, full)}${style.dim(event.type)}`);
        break;
      }
    }
  }

  flush();
  if (hiddenStderr > 0 && firstHiddenStderr !== null) {
    lines.push(
      `${cursor(firstHiddenStderr, firstHiddenAt, style, full)}${style.dim(
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
): string {
  const lines = [
    `${style.magenta("permission needed")} › ${oneLine(permission.title || "(untitled tool call)")}`,
  ];
  for (const option of permission.options) {
    lines.push(`  ${style.dim(option.kind.padEnd(12))} ${oneLine(option.name)} ${style.dim(`(${oneLine(option.optionId)})`)}`);
  }
  const allowed = permission.options.find(
    (option) => option.kind === "allow_once" || option.kind === "allow_always",
  );
  if (allowed) {
    lines.push(`  ${style.dim(`allow: ${commandPrefix} permit ${sessionId} --allow`)}`);
  }
  if (permission.options.some((option) => option.kind === "allow_always")) {
    lines.push(
      `  ${style.dim(`stop future asks: ${commandPrefix} permit ${sessionId} --allow --always`)}`,
    );
  }
  return lines.join("\n");
}

export function renderAgentTable(agents: AgentView[], style: Style): string {
  if (agents.length === 0) return style.dim("no backends configured");
  const rows = agents.map((agent) => {
    const commandLine = [agent.command, ...agent.args].join(" ");
    return [
      oneLine(agent.name),
      oneLine(agent.source),
      agent.available ? style.green("yes") : style.red("no"),
      agent.configPath ? truncateMiddle(oneLine(agent.configPath), 40) : "—",
      truncateLeft(oneLine(commandLine), 60),
      agent.available ? oneLine(agent.description ?? "—") : style.red(oneLine(agent.unavailableReason ?? "unavailable")),
    ];
  });
  return renderTable(
    ["NAME", "SOURCE", "READY", "CONFIG", "COMMAND", "NOTES"],
    rows,
    style,
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

export function formatAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const delta = Math.max(0, Date.now() - then);
  if (delta < 1_000) return "now";
  return `${formatDuration(delta)} ago`;
}

function cursor(seq: number, at: string, style: Style, full: boolean): string {
  const stamp = formatTimestamp(at, full);
  return style.gray(`#${String(seq).padEnd(4)} ${stamp ? `${stamp} ` : ""}`);
}

function formatTimestamp(at: string, full: boolean): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  if (full) return at;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

const ANSI_ESCAPE =
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Agent-derived text is untrusted: never let it inject terminal control sequences. */
export function sanitize(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "");
}

function oneLine(value: unknown): string {
  return sanitize(String(value ?? ""))
    .replace(/[\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function indent(text: string): string {
  return sanitize(text).replace(/\n/g, "\n  ");
}

const PAYLOAD_PREVIEW_CHARS = 2_000;

function renderPayload(value: unknown, style: Style): string[] {
  if (value === undefined || value === null) return [];
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
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max + 1)}`;
}

function truncateRight(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function pad(value: string, width: number): string {
  const missing = width - visibleLength(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}
