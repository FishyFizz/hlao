import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupervisorConnection } from "../../client.js";
import { HlaoError } from "../../errors.js";
import type {
  PermissionPolicy,
  ReadResult,
  SendResult,
  SpawnResult,
  WaitResult,
} from "../../protocol.js";
import { formatDuration } from "../../time.js";
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
  exitDetail,
  out,
  resolveTarget,
  sessionLabel,
  styleHint,
  warnInert,
  withProgress,
  writeJson,
  type CommandContext,
} from "../context.js";
import { helpRequested } from "../help.js";
import { parseConfigValues, parseEnv, resolveMessage } from "../input.js";
import {
  renderEvents,
  renderPermission,
  renderReadResult,
  sanitize,
  styleStatus,
} from "../render.js";

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
  // In human mode, wait in two phases so the handle is printed as soon as the
  // session exists. JSON keeps the single-call shape with firstTurn.
  const twoPhase = !ctx.json && effectiveWait;
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
    `spawned ${sessionLabel(ctx, session)} (${session.backend}) in ${session.cwd}` +
      (session.parentId ? ctx.style.dim(`  parent ${session.parentId}`) : "") +
      ctx.style.dim(`  policy ${session.permissionPolicy}`) +
      (model ? ctx.style.dim(`  model ${sanitize(model)}`) : "") +
      (configKeys.length > 0
        ? ctx.style.dim(`  config ${configKeys.join(",")}`)
        : ""),
  );

  if (twoPhase) {
    const sent = await withProgress(
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
    if (sent.timedOut) {
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
    if (result.firstTurn.text.trim().length > 0) {
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
  } else if (prompt !== undefined) {
    out(ctx.style.dim(`first message ${session.queued > 0 ? "queued" : "sent"}`));
  }
  out(styleHint(ctx, `hlao read ${session.id} --since 0`));
  return 0;
}

export async function cmdSend(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "stdin", type: "boolean" },
    { name: "prompt", type: "string", valueName: "TEXT" },
    { name: "prompt-file", type: "path", valueName: "FILE" },
    { name: "wait", type: "boolean" },
    { name: "timeout", type: "duration", valueName: "DUR" },
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

  const conn = await connect(ctx);
  const request = conn.request<SendResult>(
    "sessions.send",
    {
      sessionId,
      text,
      wait,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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

  if (result.timedOut) {
    const where =
      result.turn === null
        ? `the message is still queued behind turn ${result.session.turn}`
        : `turn ${result.turn} is still running`;
    out(
      `${sessionLabel(ctx, result.session)} ${styleStatus(result.session.status, ctx.style)} — ${where}`,
    );
    out(styleHint(ctx, `hlao read ${result.session.id} --since ${result.session.lastSeq + 1}`));
    return 2;
  }

  if (!result.completed) {
    out(
      `sent to ${sessionLabel(ctx, result.session)}` +
        (result.queued
          ? ctx.style.dim(` (queued behind turn ${result.session.turn})`)
          : result.turn !== null
            ? ctx.style.dim(` (turn ${result.turn})`)
            : ""),
    );
    return 0;
  }

  if (result.turn === null && result.stopReason === "cancelled") {
    out(`${sessionLabel(ctx, result.session)}: the queued message was cancelled before it ran`);
    return 0;
  }
  if (result.text && result.text.trim().length > 0) {
    out(sanitize(result.text).trimEnd());
  }
  const stop = result.stopReason ?? "unknown";
  out(
    ctx.style.dim(
      `— turn ${result.turn ?? "?"} ${stop === "cancelled" ? "cancelled" : `ended: ${stop}`} —`,
    ),
  );
  return 0;
}

export async function cmdRead(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "limit", type: "number", valueName: "N" },
    { name: "raw", type: "boolean" },
    { name: "verbose", type: "boolean" },
    { name: "timestamps", type: "boolean" },
    { name: "follow", type: "boolean" },
    { name: "out", type: "path", valueName: "FILE" },
  ]);
  if (helpRequested(parsed, "read")) return 0;
  expectPositionals(parsed, "read", 0, 1);

  const sessionId = resolveTarget(parsed, "read", "selfDefault");
  const ctx = contextFrom(parsed);
  const verbose = booleanOption(parsed, "verbose") === true;
  const raw = booleanOption(parsed, "raw") === true || verbose;
  const timestamps = booleanOption(parsed, "timestamps") === true;
  const follow = booleanOption(parsed, "follow") === true;
  const outFile = stringOption(parsed, "out");
  if (follow && outFile !== undefined) {
    throw usageError("--out cannot be combined with --follow");
  }
  const since = numberOption(parsed, "since");
  const limit = numberOption(parsed, "limit");
  const conn = await connect(ctx);

  if (follow) {
    return await followRead(conn, ctx, sessionId, {
      since,
      limit,
      raw,
      verbose: verbose || raw,
      timestamps,
    });
  }

  const result = await conn.request<ReadResult>("sessions.read", {
    sessionId,
    since,
    limit,
    raw,
  });

  if (outFile !== undefined) {
    try {
      writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      throw new HlaoError(
        "bad_request",
        `cannot write ${outFile}: ${(error as Error).message}`,
      );
    }
    if (ctx.json) process.stderr.write(`hlao: wrote ${outFile}\n`);
  }

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    renderReadResult(result, ctx.style, "hlao", {
      verbose: verbose || raw,
      fullTimestamps: timestamps,
    }),
  );
  if (outFile !== undefined) {
    out(ctx.style.dim(`saved ${outFile}`));
  }
  return 0;
}

interface FollowOptions {
  since?: number;
  limit?: number;
  raw: boolean;
  verbose: boolean;
  timestamps: boolean;
}

/**
 * A caller-owned watch loop: read a page, then one-shot wait for a change.
 * The supervisor owns no timer; closing the CLI aborts the pending wait.
 */
async function followRead(
  conn: SupervisorConnection,
  ctx: CommandContext,
  sessionId: string,
  options: FollowOptions,
): Promise<number> {
  let since = options.since;
  let first = true;
  for (;;) {
    const result = await conn.request<ReadResult>("sessions.read", {
      sessionId,
      since,
      limit: options.limit,
      raw: options.raw,
    });

    if (ctx.json) {
      // One complete page per line: a stream consumer can parse without framing.
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (first) {
      out(
        renderReadResult(result, ctx.style, "hlao", {
          verbose: options.verbose,
          fullTimestamps: options.timestamps,
        }),
      );
    } else {
      const lines = renderEvents(
        result.events,
        ctx.style,
        result.session.id,
        "hlao",
        {
          verbose: options.verbose,
          fullTimestamps: options.timestamps,
        },
      );
      if (lines.length > 0) out(lines.join("\n"));
      if (result.truncated) {
        out(
          ctx.style.yellow(
            `history was evicted before #${result.earliestRetainedSeq}`,
          ),
        );
      }
    }
    first = false;
    since = result.nextSeq;

    if (result.hasMore) continue;
    if (result.session.status === "closed" || result.session.status === "failed") {
      return 0;
    }

    await withProgress(
      `following ${result.session.id}`,
      conn.request<WaitResult>(
        "sessions.wait",
        {
          sessionId,
          until: "change",
          since: result.lastSeq,
          timeoutMs: 0,
        },
        { timeoutMs: 0 },
      ),
    );
  }
}

export async function cmdWait(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "until", type: "string", valueName: "STATE" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "timeout", type: "duration", valueName: "DUR" },
  ]);
  if (helpRequested(parsed, "wait")) return 0;
  expectPositionals(parsed, "wait", 0, 1);

  const sessionId = resolveTarget(parsed, "wait", "selfDefault");
  const until = stringOption(parsed, "until") ?? "idle";
  if (!["idle", "permission", "exit", "change"].includes(until)) {
    throw usageError("--until must be idle, permission, exit, or change");
  }
  if (until !== "change" && numberOption(parsed, "since") !== undefined) {
    process.stderr.write("hlao: --since only affects --until change\n");
  }
  const ctx = contextFrom(parsed);
  const timeoutMs = numberOption(parsed, "timeout");
  const conn = await connect(ctx);
  const request = conn.request<WaitResult>(
    "sessions.wait",
    {
      sessionId,
      until,
      since: numberOption(parsed, "since"),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    { timeoutMs: 0 },
  );
  const result = ctx.json
    ? await request
    : await withProgress(`waiting for ${sessionId} (${until})`, request);

  if (ctx.json) {
    writeJson(result);
    if (result.reason === "timeout") return 2;
    if (result.reason === "exit" && until !== "exit") return 3;
    return 0;
  }

  const waited = formatDuration(result.waitedMs);
  const label = sessionLabel(ctx, result.session);
  switch (result.reason) {
    case "idle":
      out(`${label} is idle (waited ${waited})`);
      return 0;
    case "permission":
      out(`${label} needs permission (waited ${waited})`);
      if (result.session.pendingPermission) {
        out(renderPermission(result.session.id, result.session.pendingPermission, ctx.style));
      }
      return 0;
    case "exit": {
      const detail = exitDetail(result.session);
      if (until === "exit") {
        out(
          `${label} is ${styleStatus(result.session.status, ctx.style)} (waited ${waited})` +
            (detail ? ctx.style.dim(` · ${detail}`) : ""),
        );
        return 0;
      }
      out(
        `${label} ended before reaching "${until}" (waited ${waited}): ` +
          `${styleStatus(result.session.status, ctx.style)}` +
          (detail ? ctx.style.dim(` · ${detail}`) : ""),
      );
      return 3;
    }
    case "change":
      out(`${label} changed at seq ${result.session.lastSeq} (waited ${waited})`);
      return 0;
    case "timeout":
      out(
        `${label} did not reach "${until}" within ${waited}; it is ${styleStatus(result.session.status, ctx.style)}`,
      );
      return 2;
    default:
      out(`${result.session.id}: ${result.reason}`);
      return 0;
  }
}

