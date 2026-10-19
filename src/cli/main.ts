import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectSupervisor, type SupervisorConnection } from "../client.js";
import {
  configFingerprint,
  loadConfig,
  mergeBackends,
  redactConfig,
  toAgentView,
} from "../config.js";
import { HlaoError, toHlaoError } from "../errors.js";
import { pidAlive, probeSupervisor, readLock, removeLock } from "../lock.js";
import { configPath, logPath, resolveHome } from "../paths.js";
import type {
  AgentsListResult,
  CancelResult,
  CloseResult,
  GetResult,
  HelloResult,
  ListResult,
  PermissionPolicy,
  PermitResult,
  ReadResult,
  ReloadResult,
  RenameResult,
  SendResult,
  SessionView,
  SetModeResult,
  SpawnResult,
  WaitResult,
} from "../protocol.js";
import { runSupervisor } from "../supervisor.js";
import { formatDuration } from "../time.js";
import { VERSION } from "../version.js";
import {
  booleanOption,
  expectPositionals,
  multipleOption,
  numberOption,
  parseArgs,
  stringOption,
  usageError,
  type OptionSpec,
  type ParsedArgs,
} from "./args.js";
import {
  colorsEnabled,
  createStyle,
  renderAgentTable,
  renderDoctor,
  renderEvents,
  renderPermission,
  renderReadResult,
  renderSessionTable,
  sanitize,
  styleStatus,
  type DoctorCheck,
  type Style,
} from "./render.js";

export const CLI_ENTRY = fileURLToPath(new URL("../cli.js", import.meta.url));

const COMMON: OptionSpec[] = [
  { name: "json", type: "boolean" },
  { name: "home", type: "path", valueName: "DIR" },
  { name: "help", short: "h", type: "boolean" },
  { name: "no-color", type: "boolean" },
];

interface CommandContext {
  home: string;
  callerSessionId: string | null;
  cliPath: string;
  json: boolean;
  style: Style;
}

export async function main(argv: string[]): Promise<number> {
  const endOfOptions = argv.indexOf("--");
  const jsonRequested = (
    endOfOptions === -1 ? argv : argv.slice(0, endOfOptions)
  ).includes("--json");
  try {
    const { rest, injected } = splitLeadingGlobals(argv);
    const first = rest[0];
    if (first === "__supervisor") {
      const parsed = parseArgs([...rest.slice(1), ...injected], COMMON);
      const home = resolveHome(stringOption(parsed, "home"), process.env);
      return await runSupervisor(home, CLI_ENTRY, VERSION);
    }

    if (first === undefined || first === "--help" || first === "-h") {
      process.stdout.write(`${fullHelp()}\n`);
      return 0;
    }
    if (first === "help") {
      const topic = rest[1];
      if (topic !== undefined && !hasCommandHelp(topic)) {
        throw usageError(`unknown help topic "${topic}" — run "hlao help"`);
      }
      process.stdout.write(`${topic ? commandHelp(topic) : fullHelp()}\n`);
      return 0;
    }
    if (first === "version" || first === "--version" || first === "-v") {
      if (jsonRequested) writeJson({ version: VERSION });
      else process.stdout.write(`hlao ${VERSION}\n`);
      return 0;
    }

    const args = [...rest.slice(1), ...injected];
    switch (first) {
      case "spawn":
        return await cmdSpawn(args);
      case "send":
        return await cmdSend(args);
      case "read":
        return await cmdRead(args);
      case "wait":
        return await cmdWait(args);
      case "list":
        return await cmdList(args);
      case "cancel":
        return await cmdCancel(args);
      case "close":
        return await cmdClose(args);
      case "permit":
        return await cmdPermit(args);
      case "mode":
        return await cmdMode(args);
      case "rename":
        return await cmdRename(args);
      case "agents":
        return await cmdAgents(args);
      case "status":
        return await cmdStatus(args);
      case "logs":
        return await cmdLogs(args);
      case "config":
        return await cmdConfig(args);
      case "reload":
        return await cmdReload(args);
      case "doctor":
        return await cmdDoctor(args);
      case "whoami":
        return await cmdWhoami(args);
      case "down":
        return await cmdDown(args);
      default:
        throw usageError(`unknown command "${first}" — run "hlao help"`);
    }
  } catch (error) {
    const converted = toHlaoError(error);
    if (jsonRequested) {
      writeJson({
        ok: false,
        error: {
          code: converted.code,
          message: converted.message,
          ...(converted.details !== undefined ? { details: converted.details } : {}),
        },
      });
    } else {
      process.stderr.write(renderError(converted));
    }
    return 1;
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdSpawn(args: string[]): Promise<number> {
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
    { name: "parent", type: "string", valueName: "SESSION" },
    { name: "permission", type: "string", valueName: "POLICY" },
    { name: "env", type: "string", valueName: "K=V", multiple: true },
  ]);
  if (helpRequested(parsed, "spawn")) return 0;
  expectPositionals(parsed, "spawn", 1, Number.POSITIVE_INFINITY);

  const backend = parsed.positionals[0]!;
  const ctx = contextFrom(parsed);
  const prompt = await resolveMessage(parsed.positionals.slice(1), parsed);
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
  out(
    `spawned ${sessionLabel(ctx, session)} (${session.backend}) in ${session.cwd}` +
      (session.parentId ? ctx.style.dim(`  parent ${session.parentId}`) : "") +
      ctx.style.dim(`  policy ${session.permissionPolicy}`),
  );

  if (twoPhase) {
    const sent = await withProgress(
      `waiting for turn 1 of ${sessionLabel(ctx, session)}`,
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

async function cmdSend(args: string[]): Promise<number> {
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

async function cmdRead(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "limit", type: "number", valueName: "N" },
    { name: "raw", type: "boolean" },
    { name: "verbose", type: "boolean" },
    { name: "timestamps", type: "boolean" },
    { name: "follow", type: "boolean" },
  ]);
  if (helpRequested(parsed, "read")) return 0;
  expectPositionals(parsed, "read", 0, 1);

  const sessionId = resolveTarget(parsed, "read", "selfDefault");
  const ctx = contextFrom(parsed);
  const verbose = booleanOption(parsed, "verbose") === true;
  const raw = booleanOption(parsed, "raw") === true || verbose;
  const timestamps = booleanOption(parsed, "timestamps") === true;
  const follow = booleanOption(parsed, "follow") === true;
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
      `following ${sessionLabel(ctx, result.session)}`,
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

async function cmdWait(args: string[]): Promise<number> {
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

async function cmdList(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "all", short: "a", type: "boolean" },
    { name: "cwd", type: "path", valueName: "DIR" },
  ]);
  if (helpRequested(parsed, "list")) return 0;
  expectPositionals(parsed, "list", 0, 0);

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const cwd = stringOption(parsed, "cwd");
  const result = await conn.request<ListResult>("sessions.list", {
    includeClosed: booleanOption(parsed, "all") ?? false,
    ...(cwd !== undefined ? { cwd: resolve(cwd) } : {}),
  });

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  if (result.sessions.length === 0) {
    out(
      ctx.style.dim(
        result.scope === "session"
          ? "no sessions in your scope"
          : "no sessions — hlao spawn <backend> \"message\"",
      ),
    );
    if (
      ctx.callerSessionId &&
      result.scope === "session" &&
      !result.sessions.some((session) => session.id === ctx.callerSessionId)
    ) {
      process.stderr.write(
        `hlao: HLAO_SESSION_ID=${ctx.callerSessionId} is not a live session; the scope is empty\n`,
      );
    }
    return 0;
  }
  out(renderSessionTable(result.sessions, ctx.style, ctx.callerSessionId));
  out(
    ctx.style.dim(
      result.scope === "operator"
        ? `scope: operator · ${result.sessions.length} visible`
        : `scope: self+descendants · ${result.sessions.length} visible · siblings not shown`,
    ),
  );
  return 0;
}

async function cmdCancel(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [...COMMON, { name: "self", type: "boolean" }]);
  if (helpRequested(parsed, "cancel")) return 0;
  expectPositionals(parsed, "cancel", 0, 1);
  const sessionId = resolveTarget(parsed, "cancel", "selfDefault");
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const result = await conn.request<CancelResult>("sessions.cancel", { sessionId });

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  const label = sessionLabel(ctx, result.session);
  if (result.session.status === "closed" || result.session.status === "failed") {
    out(`${label} is already ${styleStatus(result.session.status, ctx.style)}`);
    return 0;
  }
  if (result.session.status === "idle" && result.discarded === 0) {
    out(`${label} is idle; nothing to cancel`);
    return 0;
  }
  out(
    `cancel requested for ${label}` +
      (result.discarded > 0
        ? ctx.style.dim(` (${result.discarded} queued message${result.discarded === 1 ? "" : "s"} discarded)`)
        : ""),
  );
  return 0;
}

async function cmdClose(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "force", type: "boolean" },
    { name: "tree", type: "boolean" },
  ]);
  if (helpRequested(parsed, "close")) return 0;
  expectPositionals(parsed, "close", 0, 1);
  const sessionId = resolveTarget(parsed, "close", "selfDefault");
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const force = booleanOption(parsed, "force") ?? false;

  if (booleanOption(parsed, "tree") === true) {
    const target = await conn.request<GetResult>("sessions.get", { sessionId });
    // Closed intermediates are retained for lineage; including them lets the
    // subtree reach live grandchildren whose parent has already been closed.
    const list = await conn.request<ListResult>("sessions.list", {
      includeClosed: true,
    });
    const subtree = collectSubtree(target.session, list.sessions);
    const live = subtree.filter(
      (session) => session.status !== "closed" && session.status !== "failed",
    );
    live.sort((left, right) => right.depth - left.depth);
    const closed: SessionView[] = [];
    for (const session of live) {
      const result = await conn.request<CloseResult>("sessions.close", {
        sessionId: session.id,
        force,
      });
      if (!result.wasTerminal) closed.push(result.session);
    }
    const skipped = subtree.length - live.length;
    if (ctx.json) {
      writeJson({ count: closed.length, sessions: closed, skipped });
      return 0;
    }
    out(
      `closed ${closed.length} session${closed.length === 1 ? "" : "s"}` +
        (skipped > 0 ? ctx.style.dim(` (${skipped} already terminal)`) : ""),
    );
    return 0;
  }

  const result = await conn.request<CloseResult>("sessions.close", {
    sessionId,
    force,
  });
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  const label = sessionLabel(ctx, result.session);
  if (result.wasTerminal) {
    out(`${label} was already ${styleStatus(result.session.status, ctx.style)}`);
    return 0;
  }
  out(
    `closed ${label}` +
      (result.killed ? ctx.style.dim(" (forced)") : ""),
  );
  return 0;
}

async function cmdPermit(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "option", type: "string", valueName: "ID" },
    { name: "allow", type: "boolean" },
    { name: "deny", type: "boolean" },
    { name: "always", type: "boolean" },
  ]);
  if (helpRequested(parsed, "permit")) return 0;
  expectPositionals(parsed, "permit", 0, 1);
  const sessionId = resolveTarget(parsed, "permit", "selfDefault");

  const chosenFlags = [
    stringOption(parsed, "option") !== undefined,
    booleanOption(parsed, "allow") === true,
    booleanOption(parsed, "deny") === true,
  ].filter(Boolean).length;
  if (chosenFlags === 0) {
    throw usageError("choose --allow, --deny, or --option <id>");
  }
  if (chosenFlags > 1) {
    throw usageError("choose exactly one of --allow, --deny, --option");
  }
  const always = booleanOption(parsed, "always") ?? false;
  if (always && booleanOption(parsed, "allow") !== true) {
    throw usageError("--always must be used with --allow");
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const current = await conn.request<GetResult>("sessions.get", { sessionId });
  const permission = current.session.pendingPermission;
  if (!permission) {
    throw new HlaoError(
      "no_pending_permission",
      `session ${current.session.id} has no pending permission`,
    );
  }

  let optionId = stringOption(parsed, "option");
  if (optionId === undefined) {
    const wantsAllow = booleanOption(parsed, "allow") === true;
    const option = wantsAllow
      ? (always
          ? permission.options.find((candidate) => candidate.kind === "allow_always")
          : permission.options.find((candidate) => candidate.kind === "allow_once")) ??
        permission.options.find(
          (candidate) =>
            candidate.kind === "allow_once" || candidate.kind === "allow_always",
        )
      : permission.options.find(
          (candidate) =>
            candidate.kind === "reject_once" || candidate.kind === "reject_always",
        );
    if (!option) {
      throw new HlaoError(
        "bad_option",
        `no ${wantsAllow ? "allow" : "deny"} option was offered; use --option`,
        { options: permission.options },
      );
    }
    optionId = option.optionId;
  }

  const result = await conn.request<PermitResult>("sessions.permit", {
    sessionId: current.session.id,
    requestId: permission.requestId,
    optionId,
    ...(always ? { always: true } : {}),
  });

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  const option = permission.options.find((candidate) => candidate.optionId === optionId);
  out(
    `${styleStatus(result.session.status, ctx.style)} ${sessionLabel(ctx, result.session)} — ` +
      `${option?.kind ?? "selected"} ${optionId}` +
      (permission.title ? ctx.style.dim(` · ${permission.title}`) : "") +
      (always ? ctx.style.dim(" · future requests will be allowed automatically") : ""),
  );
  return 0;
}

async function cmdMode(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [...COMMON, { name: "self", type: "boolean" }]);
  if (helpRequested(parsed, "mode")) return 0;
  const selfUsed = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();
  let sessionId: string;
  let modeId: string | undefined;

  if (selfUsed) {
    if (!caller) throw usageError("mode: --self requires HLAO_SESSION_ID");
    expectPositionals(parsed, "mode", 0, 1);
    sessionId = caller;
    modeId = parsed.positionals[0];
  } else if (parsed.positionals.length === 0) {
    if (!caller) throw usageError("mode needs a session id");
    sessionId = caller;
    modeId = undefined;
  } else if (parsed.positionals.length === 1) {
    sessionId = parsed.positionals[0]!;
    modeId = undefined;
  } else if (parsed.positionals.length === 2) {
    sessionId = parsed.positionals[0]!;
    modeId = parsed.positionals[1];
  } else {
    throw usageError("mode takes a session id and one optional mode id");
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  if (modeId === undefined) {
    const got = await conn.request<GetResult>("sessions.get", { sessionId });
    const modes = got.session.modes;
    if (!modes) {
      throw new HlaoError(
        "bad_request",
        `backend "${got.session.backend}" does not advertise session modes`,
      );
    }
    if (ctx.json) {
      writeJson(modes);
      return 0;
    }
    out(`mode ${ctx.style.bold(modes.currentModeId)}`);
    for (const mode of modes.availableModes) {
      const marker = mode.id === modes.currentModeId ? "*" : " ";
      const description = mode.description ?? mode.name;
      out(` ${marker} ${mode.id.padEnd(20)} ${ctx.style.dim(description)}`);
    }
    return 0;
  }

  const result = await conn.request<SetModeResult>("sessions.set_mode", {
    sessionId,
    modeId,
  });
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    `mode of ${sessionLabel(ctx, result.session)}: ${ctx.style.cyan(
      result.session.modes?.currentModeId ?? modeId,
    )}`,
  );
  return 0;
}

async function cmdRename(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "clear", type: "boolean" },
  ]);
  if (helpRequested(parsed, "rename")) return 0;

  const selfUsed = booleanOption(parsed, "self") === true;
  const clear = booleanOption(parsed, "clear") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();
  let sessionId: string;
  let name: string | null;

  if (selfUsed) {
    if (!caller) throw usageError("rename: --self requires HLAO_SESSION_ID");
    expectPositionals(parsed, "rename", 0, 1);
    sessionId = caller;
    if (clear) {
      name = null;
    } else {
      name = parsed.positionals[0] ?? null;
      if (name === null) throw usageError("rename needs a new name (or --clear)");
    }
  } else if (parsed.positionals.length === 2) {
    if (clear) throw usageError("choose a new name or --clear, not both");
    sessionId = parsed.positionals[0]!;
    name = parsed.positionals[1]!;
  } else if (parsed.positionals.length === 1) {
    if (!clear) throw usageError("rename needs a new name, or --clear");
    sessionId = parsed.positionals[0]!;
    name = null;
  } else {
    if (!caller) throw usageError("rename needs a session id and a new name");
    if (!clear) throw usageError("rename needs a new name, or --clear");
    sessionId = caller;
    name = null;
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const result = await conn.request<RenameResult>("sessions.rename", {
    sessionId,
    name,
  });

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  if (result.session.name === null) {
    out(`cleared the name of ${ctx.style.bold(result.session.id)}`);
  } else {
    out(`renamed ${ctx.style.bold(result.session.name)} ${ctx.style.dim(`(${result.session.id})`)}`);
  }
  return 0;
}

async function cmdAgents(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "cwd", type: "path", valueName: "DIR" },
  ]);
  if (helpRequested(parsed, "agents")) return 0;
  expectPositionals(parsed, "agents", 0, 0);
  const ctx = contextFrom(parsed);
  // Local and non-mutating: `agents` never starts a supervisor.
  const loaded = loadConfig(ctx.home);
  if (loaded.error) throw loaded.error;
  const cwd = resolve(stringOption(parsed, "cwd") ?? process.cwd());
  const merged = mergeBackends(loaded.config.backends, cwd);
  const result: AgentsListResult = {
    agents: Object.values(merged)
      .map(toAgentView)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(renderAgentTable(result.agents, ctx.style));
  return 0;
}

async function cmdStatus(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "start", type: "boolean" },
  ]);
  if (helpRequested(parsed, "status")) return 0;
  expectPositionals(parsed, "status", 0, 0);
  const ctx = contextFrom(parsed);
  const start = booleanOption(parsed, "start") === true;

  let conn: SupervisorConnection;
  try {
    conn = await connect(ctx, start);
  } catch (error) {
    const converted = toHlaoError(error);
    if (converted.code !== "supervisor_unavailable") throw converted;
    if (ctx.json) {
      writeJson({
        running: false,
        home: ctx.home,
        hint: start ? null : "hlao status --start",
      });
    } else {
      out(`not running · home ${ctx.home}`);
      if (!start) out(ctx.style.dim("start: hlao status --start"));
    }
    return 1;
  }

  const hello = await conn.request<HelloResult>("hello", {});
  const startedAt = Date.parse(hello.startedAt);
  const up = Number.isFinite(startedAt)
    ? formatDuration(Math.max(0, Date.now() - startedAt))
    : "unknown";
  if (ctx.json) {
    writeJson({
      running: true,
      home: ctx.home,
      endpoint: conn.lock.endpoint,
      ...hello,
    });
    return 0;
  }
  out(
    `running · pid ${hello.pid} · supervisor ${hello.version} · up ${up}` +
      ctx.style.dim(` · ${hello.sessions} live session${hello.sessions === 1 ? "" : "s"}`),
  );
  out(ctx.style.dim(`protocol v${hello.protocolVersion} · ${conn.lock.endpoint}`));
  if (hello.configError) out(ctx.style.red(`config error: ${hello.configError}`));
  if (hello.configHash !== configFingerprint(ctx.home)) {
    out(ctx.style.yellow("config on disk differs from the supervisor; run: hlao reload"));
  }
  return 0;
}

async function cmdLogs(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "lines", short: "n", type: "number", valueName: "N" },
    { name: "follow", short: "f", type: "boolean" },
  ]);
  if (helpRequested(parsed, "logs")) return 0;
  expectPositionals(parsed, "logs", 0, 0);
  const ctx = contextFrom(parsed);
  const file = logPath(ctx.home);
  const requested = numberOption(parsed, "lines");
  if (requested !== undefined && requested < 0) {
    throw usageError("--lines must be zero or greater");
  }
  const follow = booleanOption(parsed, "follow") === true;
  const limit = requested ?? 50;

  let exists = existsSync(file);
  let content = "";
  if (exists) {
    try {
      content = readFileSync(file, "utf8");
    } catch (error) {
      throw new HlaoError(
        "internal",
        `cannot read ${file}: ${(error as Error).message}`,
      );
    }
  }
  const lines = splitLines(content);
  const initial = limit === 0 ? lines : lines.slice(-limit);
  emitLogLines(ctx, initial, file, exists);
  if (!follow) return 0;

  if (!exists) {
    if (!ctx.json) out(ctx.style.dim(`waiting for ${file}…`));
    while (!existsSync(file)) await sleepMs(250);
    exists = true;
  }

  let offset = exists ? byteLength(content) : 0;
  for (;;) {
    await sleepMs(400);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size === offset) continue;
    let chunk: string;
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const handle = openSync(file, "r");
      try {
        readSync(handle, buffer, 0, length, offset);
      } finally {
        closeSync(handle);
      }
      chunk = buffer.toString("utf8");
    } catch {
      continue;
    }
    offset = size;
    emitLogLines(ctx, splitLines(chunk), file, true);
  }
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function emitLogLines(
  ctx: CommandContext,
  lines: string[],
  file: string,
  exists: boolean,
): void {
  if (ctx.json) {
    for (const line of lines) {
      process.stdout.write(`${JSON.stringify({ path: file, line })}\n`);
    }
    if (lines.length === 0 && !exists) {
      process.stdout.write(`${JSON.stringify({ path: file, lines: [] })}\n`);
    }
    return;
  }
  if (lines.length === 0) {
    if (!exists) out(ctx.style.dim(`no supervisor log at ${file}`));
    return;
  }
  for (const line of lines) out(line);
}

async function cmdConfig(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "config")) return 0;
  expectPositionals(parsed, "config", 1, 1);
  const sub = parsed.positionals[0]!;
  if (!["show", "path", "validate"].includes(sub)) {
    throw usageError(`unknown config subcommand "${sub}" (show, path, validate)`);
  }
  const ctx = contextFrom(parsed);
  const file = configPath(ctx.home);

  if (sub === "path") {
    if (ctx.json) writeJson({ path: file });
    else out(file);
    return 0;
  }

  const loaded = loadConfig(ctx.home);
  if (sub === "validate") {
    if (loaded.error) throw loaded.error;
    if (ctx.json) writeJson({ ok: true, path: file });
    else out(`config OK · ${existsSync(file) ? file : "no config.json — built-in defaults"}`);
    return 0;
  }

  const redacted = redactConfig(loaded.config);
  if (ctx.json) {
    writeJson({
      path: file,
      exists: existsSync(file),
      config: redacted,
      error: loaded.error
        ? { code: loaded.error.code, message: loaded.error.message }
        : null,
    });
    return 0;
  }

  out(`config ${file}${existsSync(file) ? "" : " (missing; defaults)"}`);
  if (loaded.error) out(ctx.style.red(`invalid: ${loaded.error.message}`));
  out(`  permissionPolicy   ${redacted.permissionPolicy}`);
  out(`  waitTimeoutMs      ${formatDuration(redacted.waitTimeoutMs)}`);
  out(`  sendWaitTimeoutMs  ${formatDuration(redacted.sendWaitTimeoutMs)}`);
  out(`  startupTimeoutMs   ${formatDuration(redacted.startupTimeoutMs)}`);
  out(`  maxEventsPerSession ${redacted.maxEventsPerSession}`);
  out(`  maxEventLogBytes   ${redacted.maxEventLogBytes}`);
  out(`  maxEventBytes      ${redacted.maxEventBytes}`);
  out(`  retainClosedMs     ${formatDuration(redacted.retainClosedMs)}`);
  out("");
  out(renderAgentTable(Object.values(redacted.backends).map(toAgentView), ctx.style));
  return 0;
}

async function cmdReload(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "reload")) return 0;
  expectPositionals(parsed, "reload", 0, 0);
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const result = await conn.request<ReloadResult>("supervisor.reload", {});
  if (ctx.json) {
    writeJson(result);
    return result.configError ? 1 : 0;
  }
  if (result.configError) {
    throw new HlaoError("config_invalid", result.configError);
  }
  out(
    `config reloaded · new spawns use ${configPath(ctx.home)}; live sessions keep their settings`,
  );
  return 0;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "start", type: "boolean" },
  ]);
  if (helpRequested(parsed, "doctor")) return 0;
  expectPositionals(parsed, "doctor", 0, 0);
  const ctx = contextFrom(parsed);
  const start = booleanOption(parsed, "start") === true;
  const checks: DoctorCheck[] = [];

  const nodeOk = nodeVersionAtLeast(22, 13, 0);
  checks.push({
    name: "node",
    status: nodeOk ? "ok" : "fail",
    detail: `v${process.versions.node}${nodeOk ? "" : " — HLAO needs >= 22.13"}`,
  });

  const homeExists = existsSync(ctx.home);
  let homeIsDirectory = false;
  try {
    homeIsDirectory = homeExists && statSync(ctx.home).isDirectory();
  } catch {
    homeIsDirectory = false;
  }
  checks.push({
    name: "home",
    status: !homeExists ? "warn" : homeIsDirectory ? "ok" : "fail",
    detail: !homeExists
      ? `${ctx.home} (will be created)`
      : homeIsDirectory
        ? ctx.home
        : `${ctx.home} is not a directory`,
  });

  const loaded = loadConfig(ctx.home);
  const configFile = configPath(ctx.home);
  checks.push({
    name: "config",
    status: loaded.error ? "fail" : existsSync(configFile) ? "ok" : "warn",
    detail: loaded.error
      ? loaded.error.message
      : existsSync(configFile)
        ? configFile
        : "no config.json — built-in backends only",
  });

  let conn: SupervisorConnection | null = null;
  try {
    conn = await connect(ctx, start);
    checks.push({
      name: "supervisor",
      status: "ok",
      detail: `pid ${conn.lock.pid} · ${conn.lock.endpoint}`,
    });
  } catch (error) {
    const converted = toHlaoError(error);
    checks.push({
      name: "supervisor",
      status:
        !start && converted.code === "supervisor_unavailable" ? "warn" : "fail",
      detail:
        !start && converted.code === "supervisor_unavailable"
          ? `not running · installed · start with "hlao doctor --start" or any session command`
          : `${converted.message} · log: ${logPath(ctx.home)}`,
    });
  }

  if (conn) {
    const hello = await conn.request<HelloResult>("hello", {});
    checks.push({
      name: "wire",
      status: hello.protocolVersion === 1 ? "ok" : "fail",
      detail: `protocol v${hello.protocolVersion} · supervisor ${hello.version}`,
    });
    if (hello.version !== VERSION) {
      checks.push({
        name: "versions",
        status: "warn",
        detail: `CLI ${VERSION} · supervisor ${hello.version}`,
      });
    }
    if (hello.configError) {
      checks.push({ name: "config load", status: "fail", detail: hello.configError });
    }
    if (hello.configHash !== configFingerprint(ctx.home)) {
      checks.push({
        name: "config freshness",
        status: "warn",
        detail: "config on disk differs from the supervisor; run: hlao reload",
      });
    }
  }

  // Backend readiness is a local property of the manifest and PATH; checking it
  // must not require (or start) a supervisor.
  if (loaded.error) {
    checks.push({
      name: "backends",
      status: "fail",
      detail: `user config is invalid: ${loaded.error.message}`,
    });
  } else {
    try {
      const merged = mergeBackends(loaded.config.backends, process.cwd());
      const agents = Object.values(merged).map(toAgentView);
      const available = agents.filter((agent) => agent.available);
      const unavailable = agents.filter((agent) => !agent.available);
      checks.push({
        name: "backends",
        status: available.length > 0 ? "ok" : "fail",
        detail:
          `${available.length}/${agents.length} ready` +
          (available.length > 0
            ? ` (${available.map((agent) => agent.name).join(", ")})`
            : ""),
      });
      for (const agent of unavailable) {
        checks.push({
          name: `backend ${agent.name}`,
          status: "warn",
          detail: agent.unavailableReason ?? "unavailable",
        });
      }
    } catch (error) {
      checks.push({
        name: "backends",
        status: "fail",
        detail: toHlaoError(error).message,
      });
    }
  }

  const failed = checks.some((check) => check.status === "fail");
  if (ctx.json) {
    writeJson({ ok: !failed, checks });
    return failed ? 1 : 0;
  }
  out(renderDoctor(checks, ctx.style));
  return failed ? 1 : 0;
}

async function cmdWhoami(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "whoami")) return 0;
  expectPositionals(parsed, "whoami", 0, 0);
  const ctx = contextFrom(parsed);
  const sessionId = ctx.callerSessionId;
  const depthRaw = process.env.HLAO_DEPTH;
  const depth = depthRaw !== undefined && /^\d+$/.test(depthRaw) ? Number(depthRaw) : null;
  const result = {
    role: sessionId === null ? ("operator" as const) : ("session" as const),
    sessionId,
    name: process.env.HLAO_NAME ?? null,
    parentId: process.env.HLAO_PARENT_ID ?? null,
    rootId: process.env.HLAO_ROOT_ID ?? null,
    depth,
    backend: process.env.HLAO_BACKEND ?? null,
    home: ctx.home,
  };

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  if (sessionId === null) {
    out(`operator · home ${ctx.home}`);
  } else {
    out(
      `session ${ctx.style.bold(sessionId)}` +
        (result.name ? ` (${sanitize(result.name)})` : "") +
        ` · parent ${result.parentId ?? "—"}` +
        ` · root ${result.rootId ?? "—"}` +
        (depth !== null ? ` · depth ${depth}` : "") +
        (result.backend ? ` · backend ${result.backend}` : ""),
    );
  }
  return 0;
}

async function cmdDown(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [...COMMON, { name: "force", type: "boolean" }]);
  if (helpRequested(parsed, "down")) return 0;
  expectPositionals(parsed, "down", 0, 0);
  const ctx = contextFrom(parsed);
  const force = booleanOption(parsed, "force") ?? false;
  const lock = readLock(ctx.home);

  if (!lock) {
    if (ctx.json) writeJson({ stopped: false, reason: "not_running" });
    else out("supervisor is not running");
    return 0;
  }
  if (!pidAlive(lock.pid)) {
    removeLock(ctx.home, lock.token);
    if (ctx.json) writeJson({ stopped: false, reason: "stale_lock_removed" });
    else out("removed a stale supervisor lock; nothing was running");
    return 0;
  }

  try {
    const conn = await connectSupervisor({
      home: ctx.home,
      cliPath: ctx.cliPath,
      callerSessionId: ctx.callerSessionId,
      autostart: false,
    });
    if (!ctx.json && ctx.callerSessionId === null) {
      const hello = await conn.request<HelloResult>("hello", {});
      if (hello.sessions > 0) {
        process.stderr.write(
          `hlao: stopping closes ${hello.sessions} live session${hello.sessions === 1 ? "" : "s"} and discards their in-memory history\n`,
        );
      }
    }
    const result = await conn.request<{ sessionsClosed: number }>(
      "supervisor.shutdown",
      { force },
    );
    if (!(await waitForLockRemoval(ctx.home, 10_000))) {
      throw new HlaoError(
        "timeout",
        "the supervisor accepted shutdown but its lock is still present",
      );
    }
    if (ctx.json) writeJson({ stopped: true, ...result });
    else
      out(
        `supervisor stopped (${result.sessionsClosed} session${result.sessionsClosed === 1 ? "" : "s"} closed)`,
      );
    return 0;
  } catch (error) {
    if (!force) throw error;
    if (ctx.callerSessionId !== null) throw error;

    // Never kill a pid we cannot verify. A stale lock can outlive a crash and
    // its pid can be reused by an unrelated process. A successful hello proves
    // the endpoint and token are this supervisor's; without it, remove only the
    // lock and leave whatever owns the pid alone.
    const verified = await probeSupervisor(lock, 750);
    if (!verified) {
      removeLock(ctx.home, lock.token);
      const stillRunning = pidAlive(lock.pid);
      if (ctx.json) {
        writeJson({
          stopped: false,
          staleLockRemoved: true,
          pidLeftRunning: stillRunning,
          ...(stillRunning ? { pid: lock.pid } : {}),
        });
      } else {
        out(
          stillRunning
            ? `removed a stale lock; pid ${lock.pid} was left running because it could not be verified as the HLAO supervisor`
            : "removed a stale lock; no supervisor was running",
        );
      }
      return 0;
    }

    try {
      process.kill(lock.pid);
    } catch {
      // Already gone.
    }
    const gone = await waitFor(() => !pidAlive(lock.pid), 5_000);
    if (!gone) {
      throw new HlaoError(
        "timeout",
        `supervisor pid ${lock.pid} did not exit after the kill`,
      );
    }
    removeLock(ctx.home, lock.token);
    if (ctx.json) writeJson({ stopped: true, forced: true, sessionsClosed: 0 });
    else out("supervisor killed; lock removed");
    return 0;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * `--json` and `--home` are documented as global, so they must work before the
 * command as well as after it. Leading globals are stripped and re-injected
 * into the command's own arguments.
 */
function splitLeadingGlobals(argv: string[]): { rest: string[]; injected: string[] } {
  const injected: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--json") {
      injected.push(token);
      index += 1;
      continue;
    }
    if (token === "--home") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usageError("--home needs a directory");
      }
      injected.push("--home", value);
      index += 2;
      continue;
    }
    if (token.startsWith("--home=")) {
      injected.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return { rest: argv.slice(index), injected };
}

function contextFrom(parsed: ParsedArgs): CommandContext {
  const json = booleanOption(parsed, "json") ?? false;
  const noColor = booleanOption(parsed, "no-color") ?? false;
  return {
    home: resolveHome(stringOption(parsed, "home"), process.env),
    callerSessionId: process.env.HLAO_SESSION_ID?.trim() || null,
    cliPath: CLI_ENTRY,
    json,
    style: createStyle(colorsEnabled(json) && !noColor),
  };
}

/**
 * Resolves the session-targeting positional.
 *
 * `selfDefault` commands (read/wait/cancel/close/permit) may omit the id inside a session.
 * `selfFlag` commands (send/mode/rename) require `--self`, because their first positional is
 * already a message, mode, or new name.
 */
function resolveTarget(
  parsed: ParsedArgs,
  command: string,
  mode: "selfDefault" | "selfFlag",
): string {
  const selfFlag = booleanOption(parsed, "self") ?? false;
  const first = parsed.positionals[0];
  const caller = process.env.HLAO_SESSION_ID?.trim();

  if (selfFlag) {
    if (mode === "selfDefault" && first !== undefined) {
      throw usageError(`${command}: pass either a session id or --self`);
    }
    if (!caller) {
      throw usageError(`${command}: --self requires HLAO_SESSION_ID`);
    }
    return caller;
  }
  if (first !== undefined) return first;
  if (mode === "selfDefault" && caller) return caller;
  if (caller) {
    throw usageError(`${command} needs a session id; pass --self to target your own session`);
  }
  throw usageError(`${command} needs a session id`);
}

function sessionLabel(ctx: CommandContext, session: SessionView): string {
  return session.name
    ? `${ctx.style.bold(sanitize(session.name))} ${ctx.style.dim(`(${session.id})`)}`
    : ctx.style.bold(session.id);
}

function exitDetail(session: SessionView): string {
  if (!session.exit) return "";
  return session.exit.signal
    ? `signal ${session.exit.signal}`
    : `exit ${session.exit.code ?? "?"}`;
}

function warnInert(condition: boolean, message: string): void {
  if (condition) process.stderr.write(`hlao: ${message}\n`);
}

const PROGRESS_DELAY_MS = 2_000;

/**
 * A long wait should not look hung. The line goes to stderr only when it is a
 * TTY, so pipes and tests never see it.
 */
function withProgress<T>(label: string, work: Promise<T>): Promise<T> {
  if (process.stderr.isTTY !== true) return work;
  let shown = false;
  let width = 0;
  const timer = setTimeout(() => {
    shown = true;
    const text = `hlao: ${label}… (Ctrl-C stops watching; the work continues)`;
    width = text.length;
    process.stderr.write(`\r${text}`);
  }, PROGRESS_DELAY_MS);
  timer.unref?.();
  const clear = (): void => {
    clearTimeout(timer);
    if (!shown) return;
    process.stderr.write(`\r${" ".repeat(width)}\r`);
  };
  return work.then(
    (value) => {
      clear();
      return value;
    },
    (error: unknown) => {
      clear();
      throw error;
    },
  );
}

function connect(
  ctx: CommandContext,
  autostart = true,
): Promise<SupervisorConnection> {
  return connectSupervisor({
    home: ctx.home,
    cliPath: ctx.cliPath,
    callerSessionId: ctx.callerSessionId,
    autostart,
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function styleHint(ctx: CommandContext, text: string): string {
  return ctx.style.dim(`next: ${text}`);
}

async function resolveMessage(
  positionals: string[],
  parsed: ParsedArgs,
): Promise<string | undefined> {
  const positional = positionals.join(" ").trim();
  const prompt = stringOption(parsed, "prompt");
  const promptFile = stringOption(parsed, "prompt-file");
  const stdin = booleanOption(parsed, "stdin") ?? false;

  const sources = [
    positional.length > 0,
    prompt !== undefined,
    promptFile !== undefined,
    stdin,
  ].filter(Boolean).length;
  if (sources > 1) {
    throw usageError("provide the message one way: positional, --prompt, --prompt-file, or --stdin");
  }
  if (sources === 0) return undefined;

  let text: string;
  if (positional.length > 0) text = positional;
  else if (prompt !== undefined) text = prompt;
  else if (promptFile !== undefined) text = readTextFile(promptFile);
  else text = await readStdin();

  if (text.length === 0) throw usageError("the message is empty");
  return text;
}

function readTextFile(file: string): string {
  try {
    return stripTrailingNewline(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    throw new HlaoError(
      "bad_request",
      `cannot read ${file}: ${(error as Error).message}`,
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return stripTrailingNewline(Buffer.concat(chunks).toString("utf8"));
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function parseEnv(pairs: string[]): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw usageError(`--env expects K=V, got "${pair}"`);
    }
    const key = pair.slice(0, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw usageError(`--env name "${key}" is not a valid environment variable`);
    }
    env[key] = pair.slice(equals + 1);
  }
  return env;
}

function collectSubtree(target: SessionView, sessions: SessionView[]): SessionView[] {
  const allowed = new Set<string>([target.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (
        session.parentId !== null &&
        allowed.has(session.parentId) &&
        !allowed.has(session.id)
      ) {
        allowed.add(session.id);
        changed = true;
      }
    }
  }
  return sessions.filter((session) => allowed.has(session.id));
}

function nodeVersionAtLeast(major: number, minor: number, patch: number): boolean {
  const [currentMajor = 0, currentMinor = 0, currentPatch = 0] = process.versions.node
    .split(".")
    .map((part) => Number(part));
  if (currentMajor !== major) return currentMajor > major;
  if (currentMinor !== minor) return currentMinor > minor;
  return currentPatch >= patch;
}

function helpRequested(parsed: ParsedArgs, command: string): boolean {
  if (booleanOption(parsed, "help") === true) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return true;
  }
  return false;
}

function renderError(error: HlaoError): string {
  let text = `hlao: ${error.message}\n`;
  const details =
    typeof error.details === "object" && error.details !== null
      ? (error.details as Record<string, unknown>)
      : undefined;

  if (error.code === "ambiguous_id") {
    const candidates = details?.candidates as
      | { id: string; name: string | null; status: string }[]
      | undefined;
    for (const candidate of candidates ?? []) {
      text += `  ${candidate.id}  ${candidate.status}${candidate.name ? `  ${candidate.name}` : ""}\n`;
    }
  }

  if (typeof details?.sessionId === "string") {
    text += `  session: ${details.sessionId}\n`;
    text += `  inspect: hlao read ${details.sessionId} --json\n`;
  }

  if (Array.isArray(details?.stderr)) {
    const lines = details.stderr.slice(-5).map((line) => String(line));
    if (lines.length > 0) {
      text += "  adapter stderr:\n";
      for (const line of lines) {
        text += `    ${line.length > 300 ? `${line.slice(0, 300)}…` : line}\n`;
      }
    }
  }

  if (Array.isArray(details?.options)) {
    const options = details.options as {
      optionId?: unknown;
      id?: unknown;
      kind?: unknown;
      name?: unknown;
      description?: unknown;
    }[];
    const rendered = options
      .map((option) => {
        const id = String(option.optionId ?? option.id ?? option.name ?? "?");
        const label =
          option.name !== undefined
            ? String(option.name)
            : option.kind !== undefined
              ? String(option.kind)
              : option.description !== undefined
                ? String(option.description)
                : undefined;
        return label && label !== id ? `${id} (${label})` : id;
      })
      .join(", ");
    if (rendered.length > 0) text += `  options: ${rendered}\n`;
  }

  if (error.code === "not_found") {
    text += `run "hlao list" to see sessions in scope\n`;
  }

  if (error.code === "bad_request") {
    text += `run "hlao help" for usage\n`;
  }
  return text;
}

function waitForLockRemoval(home: string, timeoutMs: number): Promise<boolean> {
  return waitFor(() => readLock(home) === null, timeoutMs);
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) {
        resolvePromise(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolvePromise(false);
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function fullHelp(): string {
  return `HLAO — a primitive surface for agent orchestration.

One supervisor owns live agent sessions; the human operator and any agent drive
the same commands. Reads are bounded and cursor-addressed. Waits are one-shot.
There is no scheduler and no session store.

Usage:
  hlao spawn <backend> [message] [options]     open a session
  hlao send [<id>] [message] [--wait]          queue a prompt
  hlao read [<id>] [--since N] [--raw]         read orchestration state + events
  hlao wait [<id>] [--until idle|permission|exit|change] [--timeout DUR]
  hlao list [--all] [--cwd DIR]                sessions in your scope
  hlao cancel [<id>]                           stop the active turn; discard queue
  hlao close [<id>] [--force] [--tree]         end a session
  hlao permit [<id>] --allow|--deny|--option ID  answer a permission request
  hlao mode [<id>] [modeId]                    read or switch a provider mode
  hlao rename <id> <name> | --clear            label a session
  hlao agents [--cwd DIR]                      configured backends (local)
  hlao status [--start]                        supervisor state without starting one
  hlao logs [--lines N] [--follow]             supervisor diagnostics
  hlao config show|path|validate               local configuration
  hlao reload                                  re-read config for new spawns
  hlao doctor                                  environment and connectivity checks
  hlao whoami                                  this shell's scope and lineage
  hlao down [--force]                          stop the supervisor
  hlao help [command]                          this help or one command
  hlao version

Global options:
  --json                 machine output; errors are {"ok":false,"error":...}
  --home DIR             runtime home (default $HLAO_HOME or ~/.hlao)
  --no-color             disable ANSI colours (NO_COLOR also works)
  -h, --help             help
  --                     treat the rest of the line as positionals

Addressing:
  A session is addressed by its id, an unambiguous id prefix, or its name.
  Inside a spawned session, read/wait/cancel/close/permit default to the
  caller when <id> is omitted. send/mode/rename need --self for that, because
  their first positional is a message, mode, or new name.

Identity:
  An operator shell has no HLAO_SESSION_ID and sees every session. A spawned
  agent inherits HLAO_SESSION_ID, HLAO_NAME, and its lineage, and sees itself
  and its descendants only. hlao whoami reports what this shell is.

Durations: 500ms, 30s, 5m, 2h, 1d, or a bare millisecond count. 0 disables.

Exit codes: 0 ok · 1 error · 2 a bounded wait expired (work continues) ·
  3 the awaited condition was lost because the session ended.

Examples:
  hlao spawn claude "Audit the build log and report the first failure."
  hlao send --self "Check the log again." --wait --timeout 20m
  hlao rename a1b2c3 builder
  hlao permit a1b2c3 --allow --always
  hlao mode a1b2c3 auto
  hlao wait a1b2c3 --until permission --timeout 10m
  hlao read a1b2c3 --since 42
  hlao list --json`;
}

function hasCommandHelp(command: string): boolean {
  return COMMAND_HELP_NAMES.has(command) || command === "help";
}

const COMMAND_HELP_NAMES = new Set([
  "spawn",
  "send",
  "read",
  "wait",
  "list",
  "cancel",
  "close",
  "permit",
  "mode",
  "rename",
  "agents",
  "status",
  "logs",
  "config",
  "reload",
  "doctor",
  "whoami",
  "down",
]);

function commandHelp(command: string): string {
  const help: Record<string, string> = {
    spawn: `hlao spawn <backend> [message] [options]

Open a session from a configured backend. The session's identity is injected
into its environment before the adapter starts.

Options:
  --name LABEL           operator label shown in list/read
  --cwd DIR              working directory (default: current)
  --prompt TEXT          message text (alternative to the positional)
  --prompt-file FILE     read the first message from a file
  --stdin                read the first message from stdin
  --wait                 wait for the first turn to end
  --timeout DUR          bound the first-turn wait (0 = no bound)
  --mode ID              provider permission mode (see "hlao mode <id>")
  --parent SESSION       spawn under another visible session
  --permission POLICY    allow (default), ask, or deny
  --env K=V              extra environment for the adapter (repeatable)

A session can be addressed by id, id prefix, or name. In human mode --wait
prints the new handle before it starts waiting, so a long first turn is
observable. The spawn result includes the handle, label, policy, and cursor.`,
    send: `hlao send [<id>] [message] [options]

Queue a prompt. One turn runs at a time; a message sent while busy waits in a
visible queue.

Options:
  --self                 target this shell's own session (required when <id> is
                         omitted, because the first positional is the message)
  --stdin                read the message from stdin
  --prompt TEXT          message text (alternative to the positional)
  --prompt-file FILE     read the message from a file
  --wait                 wait for this message's turn to end
  --timeout DUR          bound the wait (0 = no bound)

A timeout exits 2 and leaves the turn running.`,
    read: `hlao read [<id>] [options]

Read orchestration state plus a bounded page of typed events.

Options:
  --self                 target this shell's own session
  --since N              events with seq > N (omit for the most recent page)
  --limit N              page size, 1..1000 (default 100)
  --verbose              human mode: include bounded tool input/output
  --raw                  with --json, include original ACP payloads; in human
                         mode, reveal adapter stderr and command updates
  --timestamps           show full ISO timestamps instead of HH:MM:SS
  --follow               keep reading, then one-shot wait, until the session
                         ends or you press Ctrl-C; --json emits one page per line

The response reports earliestRetainedSeq, lastSeq, nextSeq, hasMore, and
truncated. Tool payloads are omitted unless --raw/--verbose.`,
    wait: `hlao wait [<id>] [options]

One-shot await on orchestration state. It never re-arms.

Options:
  --self                 target this shell's own session
  --until idle|permission|exit|change   default idle
  --since N              baseline for "change" (default: now)
  --timeout DUR          bound; default from config (30m), 0 = no bound

A timeout exits 2. If the session ends before the condition is met, the wait
exits 3 (except --until exit, which exits 0).`,
    list: `hlao list [--all] [--cwd DIR]

List sessions visible to this shell. A session is shown by id and name; an
agent sees itself and its descendants, and an operator sees all. The footer
reports the scope, and a scoped view marks the caller's own session with *.
--all includes sessions that have closed but are still retained for reading.
--cwd filters to one working directory.`,
    cancel: `hlao cancel [<id>]

Request ACP session/cancel for the active turn and discard queued messages.
The session survives. Queued messages settle as cancelled. Inside a session,
omit <id> or pass --self.`,
    close: `hlao close [<id>] [--force] [--tree]

Close a session. ACP session/close is attempted when advertised, then the
adapter process is terminated. --force skips the protocol close. --tree closes
this session's descendants first (a CLI assembly over list + close). Inside a
session, omit <id> or pass --self.`,
    permit: `hlao permit [<id>] --allow|--deny|--option ID [--always]

Answer the session's pending permission request. --allow picks the first allow
option, --deny the first reject option, and --option names one exactly.

--always (with --allow) also switches this session's HLAO policy to allow, so
later provider requests are answered automatically. When the provider offers an
allow-always option it is preferred, which can stop the provider from asking at
all for matching commands. Inside a session, omit <id> or pass --self.`,
    mode: `hlao mode [<id>] [modeId]

Read or switch the provider's native permission mode. This is the same switch a
person uses in Claude Code; it is how you stop the provider from asking on every
tool call.

Without modeId: print the current mode and the available modes.
With modeId: request session/set_mode and report the result.
Inside a session, omit <id> to read your own; use --self <modeId> to set it.
`,
    rename: `hlao rename <id> <name> [--clear]

Give a session an operator-facing name. A unique name can then be used anywhere
a session id is accepted. Duplicate names resolve as ambiguous. --clear removes
the name. Inside a session, use --self <name> (or --self --clear).`,
    agents: `hlao agents [--cwd DIR]

Show built-in, user, and project backends with their source and readiness.
Reads configuration locally and never starts a supervisor. Environment values
are never printed, only their names.`,
    status: `hlao status [--start]

Probe the supervisor without starting one and report pid, version, uptime, live
sessions, protocol, config errors, and whether the config on disk is fresher.
Exits 1 when nothing is running. --start autostarts the supervisor first.`,
    logs: `hlao logs [--lines N] [--follow]

Read the supervisor's diagnostic log directly; no supervisor is needed. The
default is the last 50 lines; --lines 0 prints the whole file. --follow polls
for appended lines until Ctrl-C. With --json, each line is {"path","line"}.`,
    config: `hlao config show|path|validate

Local, non-mutating configuration inspection.

  show       effective values and backends; backend env values are redacted
  path       the user config path (whether or not it exists)
  validate   parse and validate the file; exits 1 on an invalid config`,
    reload: `hlao reload

Re-read the user config in the running supervisor. New spawns use the new
values; live sessions keep the settings they started with. Operator only.
An invalid file is reported and makes later spawns fail until fixed.`,
    doctor: `hlao doctor [--start]

Check node, runtime home, config, supervisor connectivity, wire version, config
freshness, and backend readiness. By default it never starts a supervisor; a
stopped supervisor is a warning ("installed"), not a failure. --start launches
one and probes it. Exits 1 only when a required check fails.`,
    whoami: `hlao whoami

Report this shell's role, session id, parent, root, depth, and backend from the
HLAO_* environment. An operator shell has no session id.`,
    down: `hlao down [--force]

Ask the supervisor to close all sessions and exit. This ends every live session
and loses its in-memory history; export anything you need first with
"hlao read <id> --since 0 --json". --force kills the process and removes the
lock when the normal path is not available.`,
  };
  return help[command] ?? fullHelp();
}
