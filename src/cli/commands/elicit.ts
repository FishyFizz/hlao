import { HlaoError } from "../../errors.js";
import type { GetResult, RespondElicitationResult } from "../../protocol.js";

import {
  booleanOption,
  parseArgs,
  usageError,
} from "../args.js";
import { COMMON, connect, contextFrom, out, sessionLabel, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { renderElicitation, sanitize, styleStatus } from "../render.js";

type Content = Record<string, string | number | boolean | string[]>;

/**
 * `hlao elicit <id>` reads the provider's pending question; `--accept`,
 * `--decline`, and `--cancel` answer it. Accept content is schema-shaped:
 * `--accept question_0="Option A" question_1='["a","b"]'`. Values parse as JSON
 * when possible, so strings, numbers, booleans, and string arrays all work.
 */
export async function cmdElicit(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "accept", type: "boolean" },
    { name: "decline", type: "boolean" },
    { name: "cancel", type: "boolean" },
  ]);
  if (helpRequested(parsed, "elicit")) return 0;

  const wantsAccept = booleanOption(parsed, "accept") === true;
  const wantsDecline = booleanOption(parsed, "decline") === true;
  const wantsCancel = booleanOption(parsed, "cancel") === true;
  const chosen = [wantsAccept, wantsDecline, wantsCancel].filter(Boolean).length;
  if (chosen > 1) {
    throw usageError("elicit: choose exactly one of --accept, --decline, --cancel");
  }

  const self = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();
  let sessionId: string;
  let pairs: string[];
  if (self) {
    if (!caller) throw usageError("elicit: --self requires HLAO_SESSION_ID");
    sessionId = caller;
    pairs = parsed.positionals;
  } else if (parsed.positionals.length > 0) {
    sessionId = parsed.positionals[0]!;
    pairs = parsed.positionals.slice(1);
  } else if (caller) {
    sessionId = caller;
    pairs = [];
  } else {
    throw usageError("elicit needs a session id");
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const current = await conn.request<GetResult>("sessions.get", { sessionId });
  const pending = current.session.pendingElicitation;

  if (chosen === 0) {
    if (!pending) {
      throw new HlaoError(
        "no_pending_elicitation",
        `session ${current.session.id} has no pending elicitation`,
      );
    }
    if (ctx.json) {
      writeJson({ session: current.session, elicitation: pending });
      return 0;
    }
    out(renderElicitation(current.session.id, pending, ctx.style));
    return 0;
  }

  if (!pending) {
    throw new HlaoError(
      "no_pending_elicitation",
      `session ${current.session.id} has no pending elicitation`,
    );
  }

  const action = wantsAccept ? "accept" : wantsDecline ? "decline" : "cancel";
  const content = wantsAccept ? parseContent(pairs) : undefined;
  if (!wantsAccept && pairs.length > 0) {
    throw usageError("elicit: content key=value pairs require --accept");
  }

  const result = await conn.request<RespondElicitationResult>(
    "sessions.respond_elicitation",
    {
      sessionId: current.session.id,
      requestId: pending.requestId,
      action,
      ...(content !== undefined ? { content } : {}),
    },
  );

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    `${styleStatus(result.session.status, ctx.style)} ${sessionLabel(ctx, result.session)} — ` +
      `elicitation ${action}` +
      (pending.message
        ? ctx.style.dim(` · ${sanitize(oneLine(pending.message))}`)
        : ""),
  );
  return 0;
}

function parseContent(pairs: string[]): Content | undefined {
  if (pairs.length === 0) return undefined;
  const content: Content = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw usageError(`elicit: expected key=value, got "${pair}"`);
    }
    const key = pair.slice(0, equals);
    const text = pair.slice(equals + 1);
    let value: unknown = text;
    if (
      text.startsWith("[") ||
      text === "true" ||
      text === "false" ||
      /^-?\d+(\.\d+)?$/.test(text)
    ) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      content[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      content[key] = value;
    } else {
      throw usageError(
        `elicit: "${key}" must be a string, number, boolean, or a JSON array of strings`,
      );
    }
  }
  return content;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
