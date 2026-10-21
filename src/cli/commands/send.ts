import type { SendResult } from "../../protocol.js";
import { formatDuration } from "../../time.js";
import {
  booleanOption,
  numberOption,
  parseArgs,
  stringOption,
  usageError,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  ensureCapability,
  hasCapability,
  out,
  resolveTarget,
  sessionLabel,
  styleHint,
  warnInert,
  withProgress,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { resolveMessage } from "../input.js";
import { sanitize, styleStatus } from "../render.js";
import { printPartialText } from "./prompt-support.js";

export async function cmdSend(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "stdin", type: "boolean" },
    { name: "prompt", type: "string", valueName: "TEXT" },
    { name: "prompt-file", type: "path", valueName: "FILE" },
    { name: "wait", type: "boolean" },
    { name: "timeout", type: "duration", valueName: "DUR" },
    { name: "idempotency-key", type: "string", valueName: "KEY" },
    { name: "steer", type: "boolean" },
    { name: "queue", type: "boolean" },
  ]);
  if (helpRequested(parsed, "send")) return 0;

  const sessionId = resolveTarget(parsed, "send", "selfFlag");
  const selfFlag = booleanOption(parsed, "self") === true;
  const messagePositionals = selfFlag
    ? parsed.positionals
    : parsed.positionals.slice(1);
  const text = await resolveMessage(messagePositionals, parsed);
  if (text === undefined) {
    const hint =
      process.env.HLAO_SESSION_ID?.trim() && parsed.positionals.length === 1 && !selfFlag
        ? `; to send "${parsed.positionals[0]}" to your own session, use: hlao send --self ${JSON.stringify(parsed.positionals[0])}`
        : "";
    throw usageError(`send needs a message (positional, --prompt, --prompt-file, or --stdin)${hint}`);
  }
  const wait = booleanOption(parsed, "wait") ?? false;
  const timeoutMs = numberOption(parsed, "timeout");
  warnInert(
    !wait && timeoutMs !== undefined,
    "--timeout has no effect without --wait",
  );
  const ctx = contextFrom(parsed);

  const steerFlag = booleanOption(parsed, "steer") === true;
  const queueFlag = booleanOption(parsed, "queue") === true;
  if (steerFlag && queueFlag) {
    throw usageError("--steer and --queue are mutually exclusive");
  }
  // Agent-to-agent messages default to steering; an operator shell keeps the
  // observable queue behavior. Either side can override explicitly.
  let steer: boolean | undefined = steerFlag
    ? true
    : queueFlag
      ? false
      : ctx.callerSessionId !== null
        ? true
        : undefined;

  const conn = await connect(ctx);
  if (steer === true) {
    if (steerFlag) {
      await ensureCapability(conn, "send.steering", "send --steer");
    } else if (!(await hasCapability(conn, "send.steering"))) {
      // A pre-0.14 supervisor rejects unknown request fields; the default is
      // optional behavior, so fall back to its queue instead of failing.
      steer = undefined;
    }
  }
  const idempotencyKey = stringOption(parsed, "idempotency-key");
  const request = conn.request<SendResult>(
    "sessions.send",
    {
      sessionId,
      text,
      wait,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(steer !== undefined ? { steer } : {}),
    },
    { timeoutMs: wait ? 0 : 60_000 },
  );
  const result =
    wait && !ctx.json
      ? await withProgress(`waiting for ${sessionId} to finish its turn`, request)
      : await request;

  if (ctx.json) {
    writeJson(result);
    return result.timedOut ? 2 : 0;
  }

  if (result.duplicate) {
    out(
      `already sent ${sanitize(result.messageId)} to ${sessionLabel(ctx, result.session)}` +
        (result.pending ? ctx.style.dim(" (still active or queued)") : ""),
    );
    return 0;
  }

  if (result.timedOut) {
    printPartialText(result.text);
    const where =
      result.turn === null
        ? `the message is still queued behind turn ${result.session.turn}`
        : `turn ${result.turn} is still running`;
    const bound =
      timeoutMs !== undefined && timeoutMs > 0
        ? ` after ${formatDuration(timeoutMs)}`
        : "";
    out(
      `${sessionLabel(ctx, result.session)} ${styleStatus(result.session.status, ctx.style)} — ` +
        `wait timed out${bound}; ${where} · ${sanitize(result.messageId)}`,
    );
    out(styleHint(ctx, `hlao read ${result.session.id} --since ${result.session.lastSeq + 1}`));
    return 2;
  }

  if (!result.completed) {
    out(
      `sent to ${sessionLabel(ctx, result.session)}` +
        (result.steered
          ? ctx.style.dim(` (steered into turn ${result.turn ?? result.session.turn})`)
          : result.queued
            ? ctx.style.dim(` (queued behind turn ${result.session.turn})`)
            : result.turn !== null
              ? ctx.style.dim(` (turn ${result.turn})`)
              : "") +
        ctx.style.dim(` · ${sanitize(result.messageId)}`),
    );
    return 0;
  }

  if (result.turn === null && result.stopReason === "cancelled") {
    out(
      `${sessionLabel(ctx, result.session)}: the queued message ${sanitize(result.messageId)} was cancelled before it ran`,
    );
    return 0;
  }
  if (result.text && result.text.trim().length > 0) {
    out(sanitize(result.text).trimEnd());
  }
  const stop = result.stopReason ?? "unknown";
  out(
    ctx.style.dim(
      `— turn ${result.turn ?? "?"} ${stop === "cancelled" ? "cancelled" : `ended: ${stop}`}${result.steered ? " (steered)" : ""} · ${sanitize(result.messageId)} —`,
    ),
  );
  return 0;
}
