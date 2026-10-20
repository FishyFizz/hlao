import type {
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
  EventType,
  PermissionView,
  QueueItemView,
  SessionConfigOptionView,
  SessionConfigValueView,
} from "../protocol.js";
import type { QueueItem } from "./queue.js";

const TEXT_PREVIEW_CHARS = 200;

/** Collapse whitespace and cap a line of text, marking the cut with an ellipsis. */
function collapseText(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

export function previewText(text: string): string {
  return collapseText(text, TEXT_PREVIEW_CHARS);
}

export function skillPointer(path: string): string {
  // A trailing blank line keeps an adapter that concatenates text blocks from
  // gluing the pointer onto the operator's first words.
  return (
    [
      `HLAO skill: read "${path}" (or run "hlao skill") before acting.`,
      "Context is whatever this prompt says, verbatim or by reference; do not invent it.",
      "HLAO carries orchestration text, not file payloads; reference paths and use your own tools.",
    ].join("\n") + "\n\n"
  );
}

const EVENT_TITLE_CHARS = 120;

/**
 * A bounded, one-line projection of an event for fleet views. It is not
 * sanitized here: the wire carries text, and every renderer sanitizes it.
 */
export function eventTitle(
  type: EventType,
  data: Record<string, unknown>,
): string | null {
  const text = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const oneLine = collapseText(value, EVENT_TITLE_CHARS);
    return oneLine.length === 0 ? null : oneLine;
  };

  switch (type) {
    case "agent.message":
    case "user.message":
    case "session.message":
    case "prompt.sent":
    case "prompt.queued":
      return text(data.text) ?? text(data.content);
    case "tool.call":
    case "tool.update":
      return text(data.title) ?? text(data.name);
    case "permission.requested":
      return text(data.title);
    case "elicitation.requested":
      return text(data.message);
    case "elicitation.resolved":
      return text(data.action);
    case "turn.ended":
      return text(data.stopReason);
    case "session.created":
      return text(data.backend) ?? "session created";
    case "session.closed":
    case "session.failed":
      return text(data.reason) ?? text(data.message);
    case "error":
      return text(data.message);
    case "notice":
      return text(data.title) ?? text(data.severity);
    case "plan":
    case "plan.update": {
      if (data.removed === true) return "plan removed";
      const entries = data.entries;
      return Array.isArray(entries)
        ? `${entries.length} plan entr${entries.length === 1 ? "y" : "ies"}`
        : "plan updated";
    }
    case "compaction":
      return (
        text(data.summary) ??
        text(data.text) ??
        text(data.status) ??
        "compaction"
      );
    case "session.info":
      return text(data.title);
    case "session.initialized": {
      const name = text(data.agentName);
      const version = text(data.agentVersion);
      return name ? (version ? `${name} ${version}` : name) : "ACP session ready";
    }
    case "usage": {
      const used = data.used;
      const size = data.size;
      return typeof used === "number" && typeof size === "number"
        ? `${used}/${size} tokens`
        : "usage updated";
    }
    default:
      return null;
  }
}

export function queueItemView(item: QueueItem, position: number | null): QueueItemView {
  return {
    id: item.id,
    position,
    textPreview: previewText(item.text),
    textLength: item.text.length,
    from: item.from,
    queuedMs: Math.max(0, Date.now() - item.enqueuedAt),
    turn: item.turn,
  };
}

export function toConfigOptionViews(
  options: SessionConfigOption[] | null | undefined,
): SessionConfigOptionView[] | null {
  if (!options) return null;
  return options.map((option) => {
    const values: SessionConfigValueView[] = [];
    if (option.type === "select") {
      for (const entry of option.options) {
        if ("group" in entry) {
          for (const value of entry.options) {
            values.push({
              value: value.value,
              name: value.name,
              ...(value.description ? { description: value.description } : {}),
              group: entry.name,
            });
          }
        } else {
          values.push({
            value: entry.value,
            name: entry.name,
            ...(entry.description ? { description: entry.description } : {}),
          });
        }
      }
    }
    return {
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
      type: option.type,
      currentValue: option.currentValue,
      values,
    };
  });
}

export function toPermissionView(
  requestId: string,
  requestedAt: string,
  request: RequestPermissionRequest,
): PermissionView {
  return {
    requestId,
    toolCallId: request.toolCall.toolCallId ?? null,
    title: request.toolCall.title ?? "",
    kind: request.toolCall.kind ?? null,
    options: request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
    requestedAt,
  };
}

export function projectUpdate(update: SessionUpdate): {
  type: EventType;
  data: Record<string, unknown>;
  textDelta?: string;
} {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = contentText(update.content);
      return {
        type: "agent.message",
        data: {
          text,
          messageId: update.messageId ?? null,
          contentType: update.content.type,
        },
        textDelta: text,
      };
    }
    case "agent_thought_chunk": {
      return {
        type: "agent.thought",
        data: {
          text: contentText(update.content),
          messageId: update.messageId ?? null,
        },
      };
    }
    case "user_message_chunk": {
      return {
        type: "user.message",
        data: { text: contentText(update.content), messageId: update.messageId ?? null },
      };
    }
    case "tool_call": {
      return {
        type: "tool.call",
        data: {
          toolCallId: update.toolCallId,
          title: update.title,
          name: update.name ?? null,
          kind: update.kind ?? null,
          status: update.status ?? null,
          locations: update.locations ?? [],
          rawInput: update.rawInput,
        },
      };
    }
    case "tool_call_update": {
      return {
        type: "tool.update",
        data: {
          toolCallId: update.toolCallId,
          title: update.title ?? null,
          name: update.name ?? null,
          kind: update.kind ?? null,
          status: update.status ?? null,
          content: update.content ?? null,
          // Some adapters (claude-agent-acp) send the real input only on the
          // first update, leaving `tool_call.rawInput` empty. Project it here
          // too, or `read --verbose` can never show the command/path.
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
        },
      };
    }
    case "plan": {
      return { type: "plan", data: { entries: update.entries } };
    }
    case "plan_update": {
      const plan = update.plan;
      const base = { update, planId: plan.planId, kind: plan.type };
      if (plan.type === "items") {
        return { type: "plan.update", data: { ...base, entries: plan.entries } };
      }
      if (plan.type === "file") {
        return { type: "plan.update", data: { ...base, uri: plan.uri } };
      }
      return { type: "plan.update", data: { ...base, content: plan.content } };
    }
    case "plan_removed": {
      return {
        type: "plan.update",
        data: { removed: true, planId: update.planId },
      };
    }
    case "available_commands_update": {
      return { type: "commands", data: { commands: update.availableCommands } };
    }
    case "current_mode_update": {
      return { type: "mode", data: { currentModeId: update.currentModeId } };
    }
    case "config_option_update": {
      return { type: "config", data: { configOptions: update.configOptions } };
    }
    case "session_info_update": {
      return {
        type: "session.info",
        data: { title: update.title ?? null, updatedAt: update.updatedAt ?? null },
      };
    }
    case "usage_update": {
      return {
        type: "usage",
        data: { used: update.used, size: update.size, cost: update.cost ?? null },
      };
    }
    case "notice": {
      return {
        type: "notice",
        data: {
          severity: update.severity,
          title: update.title,
          description: update.description ?? null,
        },
      };
    }
    case "compaction_update": {
      const summary =
        update.summary === undefined
          ? undefined
          : update.summary === null
            ? null
            : contentBlocksText(update.summary);
      return {
        type: "compaction",
        data: {
          compactionId: update.compactionId,
          status: update.status,
          ...(summary !== undefined ? { summary } : {}),
          ...(update.error !== undefined ? { error: update.error } : {}),
        },
      };
    }
    case "compaction_summary_chunk": {
      return {
        type: "compaction",
        data: {
          compactionId: update.compactionId,
          text: contentText(update.content),
          chunk: true,
        },
      };
    }
    case "subagent_update": {
      return { type: "subagent", data: {} };
    }
    case "session_message": {
      return {
        type: "session.message",
        data: {
          messageId: update.messageId,
          senderSessionId: update.senderSessionId ?? null,
          recipientSessionId: update.recipientSessionId ?? null,
          text: contentBlocksText(update.content),
          chunk: false,
        },
      };
    }
    case "session_message_chunk": {
      return {
        type: "session.message",
        data: {
          messageId: update.messageId,
          senderSessionId: update.senderSessionId ?? null,
          recipientSessionId: update.recipientSessionId ?? null,
          text: contentText(update.content),
          chunk: true,
        },
      };
    }
    default: {
      return { type: "raw", data: {} };
    }
  }
}

export function contentText(content: { type: string; text?: string }): string {
  return content.type === "text" && typeof content.text === "string" ? content.text : "";
}

/** Extract the text from a content-block array; non-text blocks contribute "". */
export function contentBlocksText(
  content: Array<{ type: string; text?: string }> | null | undefined,
): string {
  if (!content) return "";
  return content.map((block) => contentText(block)).join("");
}

