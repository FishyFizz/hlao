import type { EventView } from "../../protocol.js";
import type { Style } from "./style.js";
import {
  actorName,
  indent,
  oneLine,
  sanitize,
  truncateRight,
} from "./text.js";

export interface RenderOptions {
  verbose?: boolean;
  fullTimestamps?: boolean;
  /** The caller supplied type/turn/grep filters, so an empty page is "no match". */
  filtered?: boolean;
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
