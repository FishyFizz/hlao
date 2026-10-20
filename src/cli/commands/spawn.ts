import { resolve } from "node:path";
import { HlaoError, toHlaoError } from "../../errors.js";
import type {
  PermissionPolicy,
  SendResult,
  SpawnResult,
} from "../../protocol.js";
import {
  booleanOption,
  expectPositionals,
  multipleOption,
  numberOption,
  parseArgs,
  stringOption,
  usageError,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  out,
  sessionLabel,
  styleHint,
  warnInert,
  withProgress,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { parseConfigValues, parseEnv, resolveMessage } from "../input.js";
import { sanitize } from "../render.js";
import { printPartialText } from "./prompt-support.js";

export async function cmdSpawn(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "name", type: "string", valueName: "LABEL" },
    { name: "cwd", type: "path", valueName: "DIR" },
    { name: "prompt", type: "string", valueName: "TEXT" },
    { name: "prompt-file", type: "path", valueName: "FILE" },
    { name: "stdin", type: "boolean" },
    { name: "wait", type: "boolean" },
    { name: "timeout", type: "duration", valueName: "DUR" },
    { name: "mode", type: "string", valueName: "ID" },
    { name: "model", type: "string", valueName: "VALUE" },
    { name: "config", type: "string", valueName: "KEY=VALUE", multiple: true },
    { name: "parent", type: "string", valueName: "SESSION" },
    { name: "permission", type: "string", valueName: "POLICY" },
    { name: "env", type: "string", valueName: "K=V", multiple: true },
    { name: "no-skill", type: "boolean" },
    { name: "idempotency-key", type: "string", valueName: "KEY" },
  ]);
  if (helpRequested(parsed, "spawn")) return 0;
  expectPositionals(parsed, "spawn", 1, Number.POSITIVE_INFINITY);

  const backend = parsed.positionals[0]!;
  const ctx = contextFrom(parsed);
  const prompt = await resolveMessage(parsed.positionals.slice(1), parsed);
  const model = stringOption(parsed, "model");
  const config = parseConfigValues(multipleOption(parsed, "config"));
  const permission = stringOption(parsed, "permission");
  if (permission !== undefined && !["ask", "allow", "deny"].includes(permission)) {
    throw usageError("--permission must be ask, allow, or deny");
  }
  const wait = booleanOption(parsed, "wait") ?? false;
  const promptGiven = prompt !== undefined;
  const effectiveWait = wait && promptGiven;
  warnInert(
    !effectiveWait && numberOption(parsed, "timeout") !== undefined,
    "--timeout has no effect without a waitable first turn",
  );
  warnInert(wait && !promptGiven, "--wait has no effect without a message");

  const conn = await connect(ctx);
  const idempotencyKey = stringOption(parsed, "idempotency-key");
  // In human mode, wait in two phases so the handle is printed as soon as the
  // session exists. JSON keeps the single-call shape with firstTurn. An
  // idempotency key makes the spawn and its first prompt one atomic request.
  const twoPhase =
    !ctx.json && effectiveWait && idempotencyKey === undefined;
  const result = await conn.request<SpawnResult>(
    "sessions.spawn",
    {
      backend,
      cwd: resolve(stringOption(parsed, "cwd") ?? process.cwd()),
      name: stringOption(parsed, "name"),
      prompt: twoPhase ? undefined : prompt,
      wait: twoPhase ? false : wait,
      timeoutMs: numberOption(parsed, "timeout"),
      mode: stringOption(parsed, "mode"),
      model,
      config,
      parentSessionId: stringOption(parsed, "parent"),
      permissionPolicy: permission as PermissionPolicy | undefined,
      env: parseEnv(multipleOption(parsed, "env")),
      ...(booleanOption(parsed, "no-skill") === true ? { skill: false } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    },
    { timeoutMs: 0 },
  );

  if (ctx.json) {
    writeJson(result);
    return result.firstTurn?.timedOut ? 2 : 0;
  }

  const session = result.session;
  const configKeys = Object.keys(config ?? {});
  out(
    `${result.duplicate ? "duplicate spawn, reusing" : "spawned"} ` +
      `${sessionLabel(ctx, session)} (${session.backend}) in ${session.cwd}` +
      (session.parentId ? ctx.style.dim(`  parent ${session.parentId}`) : "") +
      ctx.style.dim(`  policy ${session.permissionPolicy}`) +
      (model ? ctx.style.dim(`  model ${sanitize(model)}`) : "") +
      (configKeys.length > 0
        ? ctx.style.dim(`  config ${configKeys.join(",")}`)
        : ""),
  );

  if (twoPhase) {
    let sent: SendResult;
    try {
      sent = await withProgress(
        `waiting for turn 1 of ${session.id}`,
        conn.request<SendResult>(
          "sessions.send",
          {
            sessionId: session.id,
            text: prompt!,
            wait: true,
            ...(numberOption(parsed, "timeout") !== undefined
              ? { timeoutMs: numberOption(parsed, "timeout") }
              : {}),
          },
          { timeoutMs: 0 },
        ),
      );
    } catch (error) {
      // The session exists even when its first turn failed; name it so the
      // operator can read or close it instead of hunting through list.
      const converted = toHlaoError(error);
      const details =
        typeof converted.details === "object" && converted.details !== null
          ? (converted.details as Record<string, unknown>)
          : undefined;
      if (details?.sessionId !== undefined) throw converted;
      throw new HlaoError(converted.code, converted.message, {
        ...details,
        sessionId: session.id,
      });
    }
    if (sent.timedOut) {
      printPartialText(sent.text);
      out(ctx.style.yellow("the first turn is still running"));
      out(styleHint(ctx, `hlao read ${session.id} --since 0`));
      return 2;
    }
    if (sent.text && sent.text.trim().length > 0) {
      out(sanitize(sent.text).trimEnd());
    }
    out(
      ctx.style.dim(
        `— turn ${sent.turn ?? 1} ended: ${sent.stopReason ?? "unknown"} —`,
      ),
    );
    out(styleHint(ctx, `hlao read ${session.id} --since 0`));
    return 0;
  }

  if (result.firstTurn) {
    if (result.firstTurn.timedOut) {
      printPartialText(result.firstTurn.text);
    } else if (result.firstTurn.text.trim().length > 0) {
      out(sanitize(result.firstTurn.text).trimEnd());
    }
    if (result.firstTurn.timedOut) {
      out(ctx.style.yellow("the first turn is still running"));
      out(styleHint(ctx, `hlao read ${session.id} --since ${session.lastSeq + 1}`));
      return 2;
    }
    out(
      ctx.style.dim(
        `— turn 1 ended: ${result.firstTurn.stopReason ?? "unknown"} —`,
      ),
    );
  } else if (result.duplicate === true) {
    out(
      ctx.style.dim(
        `reused first message ${result.messageId ?? "(already settled)"}`,
      ),
    );
  } else if (prompt !== undefined) {
    out(ctx.style.dim(`first message ${session.queued > 0 ? "queued" : "sent"}`));
  }
  out(styleHint(ctx, `hlao read ${session.id} --since 0`));
  return 0;
}
