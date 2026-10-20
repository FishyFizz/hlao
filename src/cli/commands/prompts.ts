import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupervisorConnection } from "../../client.js";
import { HlaoError, toHlaoError } from "../../errors.js";
import type {
  EventType,
  EventView,
  PermissionPolicy,
  ReadResult,
  SendResult,
  SessionView,
  SpawnResult,
  WaitResult,
} from "../../protocol.js";
import { EVENT_TYPES } from "../../protocol.js";
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
  ensureCapability,
  exitDetail,
  out,
  resolveTarget,
  sessionLabel,
  styleHint,
  warnInert,
  withProgress,
  writeJson,
  writeJsonLine,
  type CommandContext,
} from "../context.js";
import { helpRequested } from "../help.js";
import { parseConfigValues, parseEnv, resolveMessage } from "../input.js";
import { parseStatuses } from "./list.js";
import { selectSessions, selectorsUsed } from "./selectors.js";
import {
  renderEvents,
  renderPermission,
  renderReadResult,
  sanitize,
  styleStatus,
} from "../render.js";

/** A timed-out turn may have produced text; show a bounded prefix of it. */
const PARTIAL_TEXT_LIMIT = 2_000;

function printPartialText(text: string | undefined): void {
  if (text === undefined || text.trim().length === 0) return;
  const clean = sanitize(text).trimEnd();
  out(
    clean.length > PARTIAL_TEXT_LIMIT
      ? `${clean.slice(0, PARTIAL_TEXT_LIMIT)}…`
      : clean,
  );
}

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
  const idempotencyKey = stringOption(parsed, "idempotency-key");
  const request = conn.request<SendResult>(
    "sessions.send",
    {
      sessionId,
      text,
      wait,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
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
        (result.queued ? ctx.style.dim(" (still queued)") : ""),
    );
    return 0;
  }

  if (result.timedOut) {
    printPartialText(result.text);
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

const EXPORT_PAGE_SIZE = 1_000;

/**
 * Export the full retained history, not one bounded page. History is lost on
 * `down`, so this is the supported recovery path; it reports truncation when
 * the log had already evicted events.
 */
export async function cmdExport(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "raw", type: "boolean" },
    { name: "jsonl", type: "boolean" },
    { name: "out", type: "path", valueName: "FILE" },
  ]);
  if (helpRequested(parsed, "export")) return 0;
  expectPositionals(parsed, "export", 0, 1);

  const ctx = contextFrom(parsed);
  if (ctx.json && booleanOption(parsed, "jsonl") === true) {
    throw usageError("choose --json or --jsonl");
  }
  if (ctx.jsonEnvelope && booleanOption(parsed, "jsonl") === true) {
    throw usageError("--json=envelope cannot be combined with --jsonl");
  }
  const sessionId = resolveTarget(parsed, "export", "selfDefault");
  const raw = booleanOption(parsed, "raw") === true;
  const jsonl = booleanOption(parsed, "jsonl") === true;
  const outFile = stringOption(parsed, "out");
  let since = numberOption(parsed, "since") ?? 0;
  const conn = await connect(ctx);

  const events: EventView[] = [];
  let session: SessionView | null = null;
  let earliestRetainedSeq = 0;
  let lastSeq = 0;
  let truncated = false;

  for (;;) {
    const page = await conn.request<ReadResult>("sessions.read", {
      sessionId,
      since,
      limit: EXPORT_PAGE_SIZE,
      raw,
    });
    session = page.session;
    earliestRetainedSeq = page.earliestRetainedSeq;
    lastSeq = page.lastSeq;
    truncated = truncated || page.truncated;
    events.push(...page.events);
    if (!page.hasMore) break;
    const next = page.nextSeq;
    if (next <= since) {
      throw new HlaoError("internal", "export cursor did not advance");
    }
    since = next;
  }

  if (session === null) {
    throw new HlaoError("internal", "export returned no session");
  }

  if (jsonl) {
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    const text = body.length > 0 ? `${body}\n` : "";
    if (outFile !== undefined) {
      writeFileSync(resolve(outFile), text);
      if (!ctx.json) {
        out(
          `exported ${events.length} event${events.length === 1 ? "" : "s"} to ${outFile}`,
        );
      }
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  const payload = {
    session,
    events,
    earliestRetainedSeq,
    lastSeq,
    count: events.length,
    truncated,
  };

  if (outFile !== undefined) {
    writeFileSync(resolve(outFile), `${JSON.stringify(payload, null, 2)}\n`);
    if (ctx.json) {
      writeJson(payload);
    } else {
      out(
        `exported ${events.length} event${events.length === 1 ? "" : "s"} to ${outFile}` +
          (truncated
            ? ctx.style.dim(` · history begins at seq ${earliestRetainedSeq}`)
            : ""),
      );
    }
    return 0;
  }

  // Without a file, JSON on stdout keeps `hlao export <id> > history.json` safe.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

export async function cmdRead(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "before", type: "number", valueName: "SEQ" },
    { name: "limit", type: "number", valueName: "N" },
    { name: "type", type: "string", valueName: "TYPE", multiple: true },
    { name: "turn", type: "number", valueName: "N" },
    { name: "grep", type: "string", valueName: "TEXT" },
    { name: "raw", type: "boolean" },
    { name: "verbose", type: "boolean" },
    { name: "timestamps", type: "boolean" },
    { name: "follow", type: "boolean" },
    { name: "fail-on-error", type: "boolean" },
    { name: "jsonl", type: "boolean" },
    { name: "jsonl-page", type: "boolean" },
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
  const failOnError = booleanOption(parsed, "fail-on-error") === true;
  if (failOnError && !follow) {
    throw usageError("--fail-on-error requires --follow");
  }
  const jsonl = booleanOption(parsed, "jsonl") === true;
  const jsonlPage = booleanOption(parsed, "jsonl-page") === true;
  if (jsonlPage && !jsonl) {
    throw usageError("--jsonl-page requires --jsonl");
  }
  const outFile = stringOption(parsed, "out");
  if (follow && outFile !== undefined) {
    throw usageError("--out cannot be combined with --follow");
  }
  if (jsonl && ctx.json) {
    throw usageError("choose --json or --jsonl");
  }
  if (jsonl && ctx.jsonEnvelope) {
    throw usageError("--json=envelope cannot be combined with --jsonl");
  }
  if (jsonl && outFile !== undefined) {
    throw usageError("--out cannot be combined with --jsonl");
  }

  const since = numberOption(parsed, "since");
  const before = numberOption(parsed, "before");
  if (since !== undefined && before !== undefined) {
    throw usageError("--since and --before are mutually exclusive");
  }
  if (before !== undefined && follow) {
    throw usageError("--before cannot be combined with --follow");
  }
  const limit = numberOption(parsed, "limit");
  const turn = numberOption(parsed, "turn");
  if (turn !== undefined && turn < 0) throw usageError("--turn must not be negative");

  const rawTypes = multipleOption(parsed, "type");
  for (const type of rawTypes) {
    if (!(EVENT_TYPES as readonly string[]).includes(type)) {
      throw usageError(
        `unknown event type "${type}" — known types: ${EVENT_TYPES.join(", ")}`,
      );
    }
  }
  const types = rawTypes.length > 0 ? (rawTypes as EventType[]) : undefined;
  const grep = stringOption(parsed, "grep");
  if (grep === "") throw usageError("--grep needs text");

  const conn = await connect(ctx);
  if (types !== undefined || turn !== undefined || grep !== undefined) {
    await ensureCapability(conn, "read.filters", "read filters");
  }
  if (before !== undefined) {
    await ensureCapability(conn, "read.before", "read --before");
  }

  if (follow) {
    return await followRead(conn, ctx, sessionId, {
      since,
      limit,
      raw,
      types,
      turn,
      grep,
      verbose: verbose || raw,
      timestamps,
      jsonl,
      jsonlPage,
      failOnError,
      filtered:
        types !== undefined || turn !== undefined || grep !== undefined,
    });
  }

  const result = await conn.request<ReadResult>("sessions.read", {
    sessionId,
    since,
    before,
    limit,
    raw,
    types,
    turn,
    grep,
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

  if (jsonl) {
    for (const event of result.events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    return 0;
  }
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    renderReadResult(result, ctx.style, "hlao", {
      verbose: verbose || raw,
      fullTimestamps: timestamps,
      filtered: types !== undefined || turn !== undefined || grep !== undefined,
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
  types?: EventType[];
  turn?: number;
  grep?: string;
  verbose: boolean;
  timestamps: boolean;
  jsonl: boolean;
  jsonlPage: boolean;
  failOnError: boolean;
  filtered: boolean;
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
      types: options.types,
      turn: options.turn,
      grep: options.grep,
    });

    if (options.jsonl) {
      if (options.jsonlPage) {
        process.stdout.write(
          `${JSON.stringify({
            page: {
              sessionId: result.session.id,
              earliestRetainedSeq: result.earliestRetainedSeq,
              lastSeq: result.lastSeq,
              nextSeq: result.nextSeq,
              nextBefore: result.nextBefore,
              hasMore: result.hasMore,
              truncated: result.truncated,
            },
          })}\n`,
        );
      }
      for (const event of result.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      if (result.truncated && first) {
        process.stderr.write(`hlao: history was evicted before #${result.earliestRetainedSeq}\n`);
      }
    } else if (ctx.json) {
      // One complete page per line: a stream consumer can parse without framing.
      writeJsonLine(result);
    } else if (first) {
      out(
        renderReadResult(result, ctx.style, "hlao", {
          verbose: options.verbose,
          fullTimestamps: options.timestamps,
          filtered: options.filtered,
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
      return options.failOnError && result.session.status === "failed" ? 3 : 0;
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
    { name: "type", type: "string", valueName: "TYPE", multiple: true },
    { name: "grep", type: "string", valueName: "TEXT" },
    { name: "timeout", type: "duration", valueName: "DUR" },
    { name: "fail-if-failed", type: "boolean" },
    { name: "any", type: "boolean" },
    { name: "all", type: "boolean" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "tree", type: "boolean" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "idle", type: "duration", valueName: "DUR" },
    { name: "except-self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "wait")) return 0;
  expectPositionals(parsed, "wait", 0, 100);

  const any = booleanOption(parsed, "any") === true;
  const all = booleanOption(parsed, "all") === true;
  if (any && all) throw usageError("choose --any or --all, not both");
  const self = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim() || null;
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  const selectorFlags = {
    root: stringOption(parsed, "root"),
    statuses: parseStatuses(stringOption(parsed, "status")),
    idle: numberOption(parsed, "idle"),
    exceptSelf: booleanOption(parsed, "except-self") === true,
  };
  if (booleanOption(parsed, "tree") === true) {
    if (selectorFlags.root !== undefined) {
      throw usageError("wait: choose --root or --tree, not both");
    }
    if (parsed.positionals.length !== 1) {
      throw usageError("wait: --tree takes exactly one session id");
    }
    selectorFlags.root = parsed.positionals[0]!;
  }

  let ids: string[];
  if (selectorsUsed(selectorFlags)) {
    if (self) throw usageError("wait: selectors and --self are exclusive");
    if (parsed.positionals.length > 0 && booleanOption(parsed, "tree") !== true) {
      throw usageError("wait: selector flags take no session ids");
    }
    const selected = await selectSessions(conn, ctx, selectorFlags);
    if (selected.length === 0) {
      if (ctx.json) writeJson({ matched: 0, results: [] });
      else out("no sessions matched the selectors");
      return 0;
    }
    if (selected.length > 100) {
      throw usageError(
        `wait: selectors matched ${selected.length} sessions; the wire accepts at most 100`,
      );
    }
    ids = selected.map((session) => session.id);
  } else if (self) {
    if (!caller) throw usageError("wait: --self requires HLAO_SESSION_ID");
    if (parsed.positionals.length > 0) {
      throw usageError("wait: --self takes no session ids");
    }
    ids = [caller];
  } else if (parsed.positionals.length === 0) {
    if (!caller) {
      throw usageError("wait needs a session id; pass --self to target your own session");
    }
    ids = [caller];
  } else {
    ids = parsed.positionals;
  }

  const until = stringOption(parsed, "until") ?? "idle";
  if (!["idle", "settled", "permission", "exit", "change"].includes(until)) {
    throw usageError(
      "--until must be idle, settled, permission, exit, or change",
    );
  }
  // The CLI's idle is the completion signal: no active turn and no queue.
  // The wire keeps `idle` precise and exposes completion as `settled`.
  const wireUntil = until === "idle" ? "settled" : until;
  const rawTypes = multipleOption(parsed, "type");
  for (const type of rawTypes) {
    if (!(EVENT_TYPES as readonly string[]).includes(type)) {
      throw usageError(
        `unknown event type "${type}" — known types: ${EVENT_TYPES.join(", ")}`,
      );
    }
  }
  const types = rawTypes.length > 0 ? rawTypes : undefined;
  const grep = stringOption(parsed, "grep");
  if ((types !== undefined || grep !== undefined) && until !== "change") {
    throw usageError("--type and --grep require --until change");
  }
  const since = numberOption(parsed, "since");
  if (since !== undefined && ids.length > 1) {
    throw usageError("--since is only valid with a single session id");
  }
  if (until !== "change" && since !== undefined) {
    process.stderr.write("hlao: --since only affects --until change\n");
  }
  const timeoutMs = numberOption(parsed, "timeout");
  if (ids.length > 1) {
    await ensureCapability(conn, "wait.multi", "wait with several ids");
  }
  const request = conn.request<WaitResult>(
    "sessions.wait",
    {
      ...(ids.length === 1
        ? { sessionId: ids[0] }
        : { sessionIds: ids, mode: all ? "all" : "any" }),
      until: wireUntil,
      since,
      ...(types !== undefined ? { types } : {}),
      ...(grep !== undefined ? { grep } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    { timeoutMs: 0 },
  );
  const label =
    ids.length === 1
      ? `waiting for ${ids[0]} (${until})`
      : `waiting for ${ids.length} sessions (${until}, ${all ? "all" : "any"})`;
  const raw = ctx.json ? await request : await withProgress(label, request);
  // A 1.0 supervisor returns `session` without the additive `results` field.
  const results = Array.isArray(raw.results)
    ? raw.results
    : raw.session
      ? [
          {
            session: raw.session,
            satisfied: raw.satisfied,
            reason: raw.reason,
          },
        ]
      : [];
  const result: WaitResult = { ...raw, results };

  // The CLI's `idle` is satisfied by `settled`, where a terminal session counts
  // as completion. Keep the historical `--until idle` contract: a session that
  // ended before reaching idle is unsatisfied and exits 3. `--until settled`
  // deliberately treats termination as a valid completion (exit 0).
  if (until === "idle") {
    for (const entry of result.results) {
      if (entry.reason === "exit") entry.satisfied = false;
    }
    result.satisfied = all
      ? result.results.every((entry) => entry.satisfied)
      : result.results.some((entry) => entry.satisfied);
  }

  const sawExit =
    result.reason === "exit" ||
    result.results.some((entry) => entry.reason === "exit");
  const failIfFailed = booleanOption(parsed, "fail-if-failed") === true;
  const sawFailed = result.results.some(
    (entry) => entry.session.status === "failed",
  );
  const code =
    failIfFailed && sawFailed
      ? 3
      : result.reason === "timeout"
        ? 2
        : !result.satisfied && sawExit
          ? 3
          : 0;

  if (ctx.json) {
    writeJson(result);
    return code;
  }

  const waited = formatDuration(result.waitedMs);
  if (result.results.length === 1) {
    return renderSingleWait(ctx, result, result.results[0]!, until, waited);
  }

  const satisfied = result.results.filter((entry) => entry.satisfied).length;
  for (const entry of result.results) {
    const entryLabel = sessionLabel(ctx, entry.session);
    if (entry.satisfied) {
      const detail =
        entry.reason === "exit"
          ? exitDetail(entry.session)
          : entry.reason === "permission" && entry.session.pendingPermission
            ? entry.session.pendingPermission.title
            : null;
      out(
        `${entryLabel}: ${entry.reason}` + (detail ? ctx.style.dim(` · ${sanitize(detail)}`) : ""),
      );
      if (entry.reason === "permission" && entry.session.pendingPermission) {
        out(renderPermission(entry.session.id, entry.session.pendingPermission, ctx.style));
      }
    } else if (entry.reason === "pending") {
      out(`${entryLabel}: still ${styleStatus(entry.session.status, ctx.style)}`);
    } else if (entry.reason === "timeout") {
      out(
        `${entryLabel}: did not reach "${until}" ` +
          `(${styleStatus(entry.session.status, ctx.style)})`,
      );
    } else {
      out(
        `${entryLabel}: ended before reaching "${until}" ` +
          `(${styleStatus(entry.session.status, ctx.style)})`,
      );
    }
  }
  out(
    ctx.style.dim(
      `${all ? "all" : "any"}: ${satisfied}/${result.results.length} satisfied (waited ${waited})`,
    ),
  );
  return code;
}

function renderSingleWait(
  ctx: CommandContext,
  result: WaitResult,
  entry: WaitResult["results"][number],
  until: string,
  waited: string,
): number {
  const label = sessionLabel(ctx, entry.session);
  switch (result.reason) {
    case "idle":
      out(`${label} is idle (waited ${waited})`);
      return 0;
    case "permission":
      out(`${label} needs permission (waited ${waited})`);
      if (entry.session.pendingPermission) {
        out(renderPermission(entry.session.id, entry.session.pendingPermission, ctx.style));
      }
      return 0;
    case "exit": {
      const detail = exitDetail(entry.session);
      if (until === "exit") {
        out(
          `${label} is ${styleStatus(entry.session.status, ctx.style)} (waited ${waited})` +
            (detail ? ctx.style.dim(` · ${detail}`) : ""),
        );
        return 0;
      }
      out(
        `${label} ended before reaching "${until}" (waited ${waited}): ` +
          `${styleStatus(entry.session.status, ctx.style)}` +
          (detail ? ctx.style.dim(` · ${detail}`) : ""),
      );
      return 3;
    }
    case "change":
      out(`${label} changed at seq ${entry.session.lastSeq} (waited ${waited})`);
      return 0;
    case "timeout":
      out(
        `${label} did not reach "${until}" within ${waited}; it is ${styleStatus(entry.session.status, ctx.style)}`,
      );
      return 2;
    default:
      out(`${entry.session.id}: ${result.reason}`);
      return 0;
  }
}

