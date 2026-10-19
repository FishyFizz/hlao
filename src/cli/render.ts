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

export function renderSessionTable(sessions: SessionView[], style: Style): string {
  if (sessions.length === 0) return style.dim("no sessions");
  const rows = sessions.map((session) => [
    session.id,
    session.name ?? "—",
    session.backend,
    styleStatus(session.status, style),
    String(session.turn),
    session.queued > 0 ? String(session.queued) : "—",
    formatAge(session.lastActivityAt),
    truncateLeft(session.cwd, 60),
  ]);
  return renderTable(
    ["ID", "NAME", "BACKEND", "STATUS", "TURN", "QUEUED", "AGE", "CWD"],
    rows,
    style,
  );
}

export function renderSessionHeader(session: SessionView, style: Style): string {
  const parts = [
    style.bold(session.id),
    session.name ? style.cyan(session.name) : null,
    session.backend,
    styleStatus(session.status, style),
  ].filter((part): part is string => part !== null);
  const details = [
    `cwd ${session.cwd}`,
    `turn ${session.turn}`,
    `seq ${session.lastSeq}`,
    session.queued > 0 ? `queued ${session.queued}` : null,
    session.modes ? `mode ${session.modes.currentModeId}` : null,
    `policy ${session.permissionPolicy}`,
    session.parentId ? `parent ${session.parentId}` : "root",
    session.processId ? `pid ${session.processId}` : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join("  ")}\n${style.dim(details.join(" · "))}`;
}

export function renderReadResult(
  result: ReadResult,
  style: Style,
  commandPrefix = "hlao",
  verbose = false,
): string {
  const lines: string[] = [renderSessionHeader(result.session, style)];

  if (result.session.pendingPermission) {
    lines.push("");
    lines.push(renderPermission(result.session.id, result.session.pendingPermission, style, commandPrefix));
  }

  if (result.events.length === 0) {
    lines.push("");
    lines.push(style.dim("no events"));
  } else {
    lines.push("");
    lines.push(
      ...renderEvents(result.events, style, result.session.id, commandPrefix, verbose),
    );
  }

  if (result.truncated) {
    lines.push("");
    lines.push(
      style.yellow(
        `earlier events were evicted; retained history starts at #${result.earliestRetainedSeq}`,
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
  verbose = false,
): string[] {
  const lines: string[] = [];
  let agentText = "";
  let agentSeq = 0;
  let agentMessageId: string | null = null;
  let thoughtText = "";
  let thoughtSeq = 0;
  let hiddenStderr = 0;
  let firstHiddenStderr: number | null = null;

  const flushAgent = (): void => {
    if (agentText.length > 0) {
      lines.push(`${cursor(agentSeq, style)}${style.cyan("agent")} › ${indent(agentText)}`);
      agentText = "";
      agentMessageId = null;
    }
  };
  const flushThought = (): void => {
    if (thoughtText.length > 0) {
      lines.push(`${cursor(thoughtSeq, style)}${style.dim("thinking")} › ${style.dim(indent(thoughtText))}`);
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
        if (agentText.length === 0) agentSeq = event.seq;
        if (messageId !== null) agentMessageId = messageId;
        agentText += typeof data.text === "string" ? data.text : "";
        break;
      }
      case "agent.thought": {
        flushAgent();
        if (thoughtText.length === 0) thoughtSeq = event.seq;
        thoughtText += typeof data.text === "string" ? data.text : "";
        break;
      }
      case "user.message":
        break;
      case "prompt.sent": {
        flush();
        const text = typeof data.text === "string" ? data.text : "";
        lines.push(`${cursor(event.seq, style)}${style.bold("you")} › ${indent(text)}`);
        break;
      }
      case "prompt.queued": {
        flush();
        lines.push(
          `${cursor(event.seq, style)}${style.dim(`queued message (position ${String(data.position ?? "?")})`)}`,
        );
        break;
      }
      case "prompt.discarded": {
        flush();
        lines.push(
          `${cursor(event.seq, style)}${style.dim(`discarded a queued message (${String(data.reason ?? "cancelled")})`)}`,
        );
        break;
      }
      case "turn.started": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim(`— turn ${String(data.turn ?? event.turn ?? "?")} —`)}`);
        break;
      }
      case "turn.ended": {
        flush();
        const stop = String(data.stopReason ?? "unknown");
        lines.push(
          `${cursor(event.seq, style)}${style.dim(`— turn ${String(data.turn ?? event.turn ?? "?")} ended: ${stop} —`)}`,
        );
        break;
      }
      case "tool.call": {
        flush();
        const title = String(data.title ?? data.toolCallId ?? "tool");
        const kind = data.kind ? style.dim(` [${String(data.kind)}]`) : "";
        lines.push(`${cursor(event.seq, style)}${style.yellow("tool")} › ${title}${kind}`);
        break;
      }
      case "tool.update": {
        flush();
        const status = typeof data.status === "string" ? data.status : "updated";
        const title = String(data.title ?? data.toolCallId ?? "tool");
        if (status !== "completed" && status !== "failed") break;
        const colour = status === "failed" ? style.red : style.dim;
        lines.push(`${cursor(event.seq, style)}${style.yellow("tool")} › ${title} ${colour(`→ ${status}`)}`);
        break;
      }
      case "permission.requested": {
        flush();
        const options = Array.isArray(data.options)
          ? (data.options as { optionId: string; name: string; kind: string }[])
          : [];
        const title = String(data.title ?? "permission required");
        if (data.auto === true) {
          lines.push(
            `${cursor(event.seq, style)}${style.magenta("permission")} › ${title} ${style.dim(`— auto-answered by policy:${String(data.policy ?? "allow")}`)}`,
          );
          break;
        }
        lines.push(
          `${cursor(event.seq, style)}${style.magenta("permission needed")} › ${title}`,
        );
        for (const option of options) {
          lines.push(`  ${style.dim(option.kind.padEnd(12))} ${option.name} ${style.dim(`(${option.optionId})`)}`);
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
        const answer = data.optionId === null ? "cancelled" : String(data.optionId);
        lines.push(
          `${cursor(event.seq, style)}${style.magenta("permission")} › ${answer} ${style.dim(`(${String(data.by ?? "unknown")})`)}`,
        );
        break;
      }
      case "policy.changed": {
        flush();
        lines.push(
          `${cursor(event.seq, style)}${style.magenta("policy")} › ${String(data.permissionPolicy ?? "")} ${style.dim(`(${String(data.by ?? "unknown")})`)}`,
        );
        break;
      }
      case "session.created": {
        flush();
        lines.push(
          `${cursor(event.seq, style)}${style.dim(`session created · ${String(data.backend ?? "")} · ${String(data.cwd ?? "")}`)}`,
        );
        break;
      }
      case "session.initialized": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim("ACP session ready")}`);
        break;
      }
      case "session.closed": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim("session closed")}`);
        break;
      }
      case "session.failed": {
        flush();
        lines.push(
          `${cursor(event.seq, style)}${style.red(`session failed: ${String(data.message ?? "unknown")}`)}`,
        );
        break;
      }
      case "cancel.requested": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim("cancel requested")}`);
        break;
      }
      case "error": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.red(`error: ${String(data.message ?? "unknown")}`)}`);
        break;
      }
      case "stderr": {
        flush();
        if (verbose) {
          lines.push(`${cursor(event.seq, style)}${style.dim(`stderr › ${String(data.text ?? "")}`)}`);
        } else {
          hiddenStderr += 1;
          if (firstHiddenStderr === null) firstHiddenStderr = event.seq;
        }
        break;
      }
      case "notice": {
        flush();
        lines.push(
          `${cursor(event.seq, style)}${style.cyan("notice")} › ${String(data.title ?? "")}${
            data.description ? style.dim(` — ${String(data.description)}`) : ""
          }`,
        );
        break;
      }
      case "usage": {
        flush();
        const used = Number(data.used ?? 0);
        const size = Number(data.size ?? 0);
        lines.push(`${cursor(event.seq, style)}${style.dim(`usage › ${used}/${size} tokens`)}`);
        break;
      }
      case "plan": {
        flush();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        lines.push(`${cursor(event.seq, style)}${style.cyan("plan")} › ${entries.length} entries`);
        for (const entry of entries.slice(0, 10)) {
          const item = entry as { status?: string; content?: string };
          lines.push(`  ${style.dim(`[${item.status ?? "?"}]`)} ${item.content ?? ""}`);
        }
        break;
      }
      case "mode": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim(`mode › ${String(data.currentModeId ?? "")}`)}`);
        break;
      }
      case "config": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim("config updated")}`);
        break;
      }
      case "commands": {
        flush();
        if (!verbose) break;
        const commands = Array.isArray(data.commands) ? data.commands.length : 0;
        lines.push(`${cursor(event.seq, style)}${style.dim(`commands › ${commands} available`)}`);
        break;
      }
      case "session.info": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim(`session › ${String(data.title ?? "")}`)}`);
        break;
      }
      case "plan.update":
      case "compaction":
      case "subagent":
      case "raw": {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim(event.type)}`);
        break;
      }
      default: {
        flush();
        lines.push(`${cursor(event.seq, style)}${style.dim(event.type)}`);
        break;
      }
    }
  }

  flush();
  if (hiddenStderr > 0 && firstHiddenStderr !== null) {
    lines.push(
      `${cursor(firstHiddenStderr, style)}${style.dim(
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
    `${style.magenta("permission needed")} › ${permission.title || "(untitled tool call)"}`,
  ];
  for (const option of permission.options) {
    lines.push(`  ${style.dim(option.kind.padEnd(12))} ${option.name} ${style.dim(`(${option.optionId})`)}`);
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
    const notes = agent.available
      ? (agent.description ?? "—")
      : style.red(agent.unavailableReason ?? "unavailable");
    return [
      agent.name,
      agent.source,
      agent.available ? style.green("yes") : style.red("no"),
      truncateLeft(commandLine, 60),
      notes,
    ];
  });
  return renderTable(["NAME", "SOURCE", "READY", "COMMAND", "NOTES"], rows, style);
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

function cursor(seq: number, style: Style): string {
  return style.gray(`#${String(seq).padEnd(4)} `);
}

function indent(text: string): string {
  return text.replace(/\n/g, "\n  ");
}

function truncateLeft(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max + 1)}`;
}

function pad(value: string, width: number): string {
  const missing = width - visibleLength(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}
