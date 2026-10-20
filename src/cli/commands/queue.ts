

import type { QueueDropResult, QueueResult } from "../../protocol.js";
import { formatDuration } from "../../time.js";
import { booleanOption, parseArgs, stringOption, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, sessionLabel, writeJson, type CommandContext } from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";

export async function cmdQueue(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "id", type: "string", valueName: "MESSAGE" },
  ]);
  if (helpRequested(parsed, "queue")) return 0;
  const selfUsed = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();
  const positionals = [...parsed.positionals];
  const drop = positionals[0] === "drop";
  if (drop) positionals.shift();
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  if (!drop) {
    if (positionals.length > 1) {
      throw usageError("queue takes at most one session id");
    }
    let sessionId: string;
    if (selfUsed) {
      if (!caller) throw usageError("queue: --self requires HLAO_SESSION_ID");
      sessionId = caller;
    } else if (positionals[0] !== undefined) {
      sessionId = positionals[0];
    } else if (caller) {
      sessionId = caller;
    } else {
      throw usageError("queue needs a session id");
    }

    const result = await conn.request<QueueResult>("sessions.queue", {
      sessionId,
    });
    if (ctx.json) {
      writeJson(result);
      return 0;
    }
    out(renderQueue(result, ctx));
    return 0;
  }

  const idOption = stringOption(parsed, "id");
  let sessionId: string;
  let positionRaw: string | undefined;
  let messageId: string | undefined;

  if (idOption !== undefined) {
    if (positionals.length > 1) {
      throw usageError("queue drop --id takes at most one session id");
    }
    if (selfUsed) {
      if (!caller) throw usageError("queue: --self requires HLAO_SESSION_ID");
      if (positionals.length > 0) {
        throw usageError("queue drop: choose --self or a session id");
      }
      sessionId = caller;
    } else if (positionals.length === 1) {
      sessionId = positionals[0]!;
    } else if (caller) {
      sessionId = caller;
    } else {
      throw usageError("queue drop --id needs a session id (or HLAO_SESSION_ID)");
    }
    messageId = idOption;
  } else {
    if (selfUsed) {
      if (!caller) throw usageError("queue: --self requires HLAO_SESSION_ID");
      if (positionals.length !== 1) {
        throw usageError("queue drop --self expects one position");
      }
      sessionId = caller;
      positionRaw = positionals[0];
    } else if (positionals.length === 2) {
      sessionId = positionals[0]!;
      positionRaw = positionals[1];
    } else if (positionals.length === 1 && caller) {
      sessionId = caller;
      positionRaw = positionals[0];
    } else {
      throw usageError("queue drop needs [<id>] <position>, or --id <message>");
    }
  }

  let position: number | undefined;
  if (messageId === undefined) {
    position = Number(positionRaw);
    if (!Number.isInteger(position) || position < 1 || position > 1_000) {
      throw usageError("queue position must be an integer from 1 to 1000");
    }
  }
  const result = await conn.request<QueueDropResult>("sessions.queue_drop", {
    sessionId,
    ...(messageId !== undefined ? { messageId } : { position }),
  });
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    `dropped ${sanitize(result.dropped.id)} (#${result.dropped.position}) from ` +
      `${sessionLabel(ctx, result.session)}: ${sanitize(result.dropped.textPreview)}`,
  );
  return 0;
}

function renderQueue(result: QueueResult, ctx: CommandContext): string {
  const label = sessionLabel(ctx, result.session);
  if (!result.active && result.queue.length === 0) {
    return `queue of ${label} is empty`;
  }
  const lines = [`queue of ${label} · ${result.queue.length} queued`];
  if (result.active) {
    lines.push(
      `  active turn ${result.active.turn ?? "?"} from ${sanitize(result.active.from)} · ${formatDuration(result.active.queuedMs)}`,
    );
  }
  for (const item of result.queue) {
    lines.push(
      `  #${item.position}  ${sanitize(item.id)}  ${sanitize(item.from)}  ${formatDuration(item.queuedMs)}  ` +
        sanitize(item.textPreview) +
        (item.textLength > item.textPreview.length
          ? ctx.style.dim(` (${item.textLength} chars)`)
          : ""),
    );
  }
  return lines.join("\n");
}
