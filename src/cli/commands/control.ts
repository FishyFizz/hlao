import type { SupervisorConnection } from "../../client.js";
import { HlaoError } from "../../errors.js";
import type {
  CancelResult,
  CloseResult,
  ForgetResult,
  GetResult,
  ListResult,
  PermissionPolicy,
  PermitResult,
  QueueDropResult,
  QueueResult,
  RenameResult,
  SessionView,
  SetConfigOptionResult,
  SetModeResult,
  SetPolicyResult,
  WaitResult,
} from "../../protocol.js";
import { formatDuration } from "../../time.js";
import {
  booleanOption,
  expectPositionals,
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
  resolveTarget,
  sessionLabel,
  writeJson,
  type CommandContext,
} from "../context.js";
import { helpRequested } from "../help.js";
import {
  renderSessionHeader,
  renderTable,
  sanitize,
  styleStatus,
} from "../render.js";
import { parseStatuses, resolveInList } from "./list.js";
import { isTerminal, selectSessions, selectorsUsed } from "./selectors.js";

export async function cmdCancel(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "keep-queue", type: "boolean" },
    { name: "wait", type: "boolean" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "tree", type: "boolean" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "idle", type: "duration", valueName: "DUR" },
    { name: "except-self", type: "boolean" },
    { name: "timeout", type: "duration", valueName: "DUR" },
  ]);
  if (helpRequested(parsed, "cancel")) return 0;
  expectPositionals(parsed, "cancel", 0, 1);

  const ctx = contextFrom(parsed);
  const keepQueue = booleanOption(parsed, "keep-queue") === true;
  const wait = booleanOption(parsed, "wait") === true;
  const timeoutMs = numberOption(parsed, "timeout");
  const conn = await connect(ctx);

  const selectorFlags = {
    root: stringOption(parsed, "root"),
    statuses: parseStatuses(stringOption(parsed, "status")),
    idle: numberOption(parsed, "idle"),
    exceptSelf: booleanOption(parsed, "except-self") === true,
  };
  if (booleanOption(parsed, "tree") === true) {
    if (selectorFlags.root !== undefined) {
      throw usageError("cancel: choose --root or --tree, not both");
    }
    if (parsed.positionals.length !== 1) {
      throw usageError("cancel: --tree takes exactly one session id");
    }
    selectorFlags.root = parsed.positionals[0]!;
  }

  if (selectorsUsed(selectorFlags)) {
    if (booleanOption(parsed, "self") === true) {
      throw usageError("cancel: selectors and --self are exclusive");
    }
    if (parsed.positionals.length > 0 && booleanOption(parsed, "tree") !== true) {
      throw usageError("cancel: selector flags take no session ids");
    }
    const selected = await selectSessions(conn, ctx, selectorFlags);
    const live = selected.filter((session) => !isTerminal(session));
    if (selected.length === 0) {
      if (ctx.json) writeJson({ count: 0, discarded: 0, sessions: [] });
      else out("no sessions matched the selectors");
      return 0;
    }

    let discarded = 0;
    const cancelled: SessionView[] = [];
    for (const session of live) {
      const result = await conn.request<CancelResult>("sessions.cancel", {
        sessionId: session.id,
        ...(keepQueue ? { keepQueue: true } : {}),
      });
      discarded += result.discarded;
      cancelled.push(result.session);
    }

    let waited: WaitResult | undefined;
    if (wait) {
      waited = await conn.request<WaitResult>(
        "sessions.wait",
        {
          sessionIds: selected.map((session) => session.id),
          mode: "all",
          until: "settled",
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        { timeoutMs: 0 },
      );
    }

    if (ctx.json) {
      writeJson({
        count: cancelled.length,
        discarded,
        sessions: cancelled,
        ...(waited !== undefined ? { waited } : {}),
      });
      return 0;
    }
    out(
      `cancelled ${cancelled.length} session${cancelled.length === 1 ? "" : "s"}` +
        (discarded > 0
          ? ctx.style.dim(
              ` · ${discarded} queued message${discarded === 1 ? "" : "s"} discarded`,
            )
          : "") +
        (keepQueue ? ctx.style.dim(" · queue kept") : ""),
    );
    if (waited !== undefined) {
      out(
        waited.satisfied
          ? ctx.style.dim("all selected sessions are settled")
          : ctx.style.yellow("not every selected session settled before the timeout"),
      );
    }
    return waited !== undefined && !waited.satisfied ? 2 : 0;
  }

  const sessionId = resolveTarget(parsed, "cancel", "selfDefault");
  const result = await conn.request<CancelResult>("sessions.cancel", {
    sessionId,
    ...(keepQueue ? { keepQueue: true } : {}),
  });

  let waited: WaitResult | undefined;
  if (wait) {
    waited = await conn.request<WaitResult>(
      "sessions.wait",
      {
        sessionId: result.session.id,
        until: "settled",
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      { timeoutMs: 0 },
    );
  }

  if (ctx.json) {
    writeJson({ ...result, ...(waited !== undefined ? { waited } : {}) });
    return waited !== undefined && !waited.satisfied ? 2 : 0;
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
      (keepQueue && result.session.queued > 0
        ? ctx.style.dim(
            ` (queue kept: ${result.session.queued} message${result.session.queued === 1 ? "" : "s"})`,
          )
        : result.discarded > 0
          ? ctx.style.dim(` (${result.discarded} queued message${result.discarded === 1 ? "" : "s"} discarded)`)
          : ""),
  );
  if (waited !== undefined) {
    out(
      waited.satisfied
        ? ctx.style.dim(`settled after ${formatDuration(waited.waitedMs)}`)
        : ctx.style.yellow(`not settled within ${formatDuration(waited.waitedMs)}`),
    );
  }
  return waited !== undefined && !waited.satisfied ? 2 : 0;
}

export async function cmdGet(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "get")) return 0;
  expectPositionals(parsed, "get", 0, 1);
  const sessionId = resolveTarget(parsed, "get", "selfDefault");
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const got = await conn.request<GetResult>("sessions.get", { sessionId });
  if (ctx.json) {
    writeJson(got);
    return 0;
  }
  out(renderSessionHeader(got.session, ctx.style));
  return 0;
}

export async function cmdClose(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "force", type: "boolean" },
    { name: "tree", type: "boolean" },
    { name: "idle", type: "duration", valueName: "DUR" },
    { name: "failed", type: "boolean" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "dry-run", type: "boolean" },
    { name: "except-self", type: "boolean" },
    { name: "forget", type: "boolean" },
  ]);
  if (helpRequested(parsed, "close")) return 0;

  const idle = numberOption(parsed, "idle");
  const failed = booleanOption(parsed, "failed") === true;
  const statusRaw = stringOption(parsed, "status");
  const rootToken = stringOption(parsed, "root");
  const bulk =
    idle !== undefined ||
    failed ||
    statusRaw !== undefined ||
    rootToken !== undefined;
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const force = booleanOption(parsed, "force") ?? false;
  const forget = booleanOption(parsed, "forget") === true;
  const dryRun = booleanOption(parsed, "dry-run") === true;

  if (bulk) {
    if (parsed.positionals.length > 0) {
      throw usageError("close takes either a session id or selector flags");
    }
    if (
      booleanOption(parsed, "self") === true ||
      booleanOption(parsed, "tree") === true
    ) {
      throw usageError("--self and --tree are only for a single session id");
    }
    return await closeBulk(conn, ctx, {
      idle,
      statuses: new Set([
        ...(failed ? ["failed"] : []),
        ...(parseStatuses(statusRaw) ?? []),
      ]),
      rootToken,
      force,
      forget,
      dryRun,
      exceptSelf: booleanOption(parsed, "except-self") === true,
    });
  }

  expectPositionals(parsed, "close", 0, 1);
  const sessionId = resolveTarget(parsed, "close", "selfDefault");

  if (booleanOption(parsed, "tree") === true) {
    if (forget) throw usageError("--forget cannot be combined with --tree");
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

    // A dry run must report before any close. This branch used to sit before
    // the dry-run check and closed the tree for real.
    if (dryRun) {
      const skipped = subtree.length - live.length;
      if (ctx.json) {
        writeJson({
          dryRun: true,
          count: live.length,
          skipped,
          sessions: subtree,
        });
        return 0;
      }
      out(ctx.style.dim("dry run; no session was changed"));
      out(
        renderTable(
          ["ID", "NAME", "STATUS", "ACTION"],
          live.map((session) => [
            session.id,
            sanitize(session.name ?? "—"),
            styleStatus(session.status, ctx.style),
            "close",
          ]),
          ctx.style,
        ),
      );
      out(
        `would close ${live.length} session${live.length === 1 ? "" : "s"}` +
          (skipped > 0 ? ctx.style.dim(` (${skipped} already terminal)`) : ""),
      );
      return 0;
    }

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

  if (dryRun) {
    const got = await conn.request<GetResult>("sessions.get", { sessionId });
    const terminal =
      got.session.status === "closed" || got.session.status === "failed";
    const action = terminal
      ? forget
        ? "forget"
        : "skip"
      : "close";
    if (ctx.json) {
      writeJson({ dryRun: true, action, session: got.session });
      return 0;
    }
    out(
      `would ${action === "skip" ? "skip (already terminal)" : action} ` +
        sessionLabel(ctx, got.session),
    );
    return 0;
  }

  if (forget) {
    const forgotten = await conn.request<ForgetResult>("sessions.forget", {
      sessionId,
    });
    if (ctx.json) {
      writeJson(forgotten);
      return 0;
    }
    out(`forgot ${ctx.style.bold(forgotten.sessionId)}`);
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

interface CloseBulkOptions {
  idle?: number;
  statuses: Set<string>;
  rootToken?: string;
  force: boolean;
  forget: boolean;
  dryRun: boolean;
  exceptSelf: boolean;
}

async function closeBulk(
  conn: SupervisorConnection,
  ctx: CommandContext,
  options: CloseBulkOptions,
): Promise<number> {
  const list = await conn.request<ListResult>("sessions.list", {
    includeClosed: true,
  });
  let targets = list.sessions;
  if (options.rootToken !== undefined) {
    const root = resolveInList(list.sessions, options.rootToken);
    targets = targets.filter((session) => session.rootId === root.rootId);
  }
  if (options.statuses.size > 0) {
    // `status: idle` with a queued prompt is still work; surface it as busy so
    // a bulk cleanup cannot discard the queue.
    targets = targets.filter((session) =>
      options.statuses.has(
        session.status === "idle" && session.queued > 0
          ? "busy"
          : session.status,
      ),
    );
  }
  if (options.idle !== undefined) {
    const now = Date.now();
    targets = targets.filter((session) => {
      if (!session.settled) return false;
      const last = Date.parse(session.lastActivityAt);
      return Number.isFinite(last) && now - last >= options.idle!;
    });
  }
  if (options.exceptSelf && ctx.callerSessionId !== null) {
    targets = targets.filter(
      (session) => session.id !== ctx.callerSessionId,
    );
  }
  targets = [...targets].sort((left, right) => right.depth - left.depth);

  if (targets.length === 0) {
    if (ctx.json) {
      writeJson({ count: 0, forgotten: 0, skipped: 0, sessions: [] });
    } else {
      out(ctx.style.dim("no sessions matched"));
    }
    return 0;
  }

  const terminal = (session: SessionView): boolean =>
    session.status === "closed" || session.status === "failed";

  if (options.dryRun) {
    const wouldForget = targets.filter(
      (session) => terminal(session) && options.forget,
    ).length;
    const wouldClose = targets.filter((session) => !terminal(session)).length;
    const skipped = targets.length - wouldForget - wouldClose;
    if (ctx.json) {
      writeJson({
        dryRun: true,
        count: wouldClose,
        forgotten: wouldForget,
        skipped,
        sessions: targets,
      });
      return 0;
    }
    out(ctx.style.dim("dry run; no session was changed"));
    out(
      renderTable(
        ["ID", "NAME", "STATUS", "ACTION"],
        targets.map((session) => [
          session.id,
          sanitize(session.name ?? "—"),
          styleStatus(session.status, ctx.style),
          terminal(session)
            ? options.forget
              ? "forget"
              : "skip"
            : "close",
        ]),
        ctx.style,
      ),
    );
    out(
      `would close ${wouldClose} · forget ${wouldForget} · skip ${skipped}`,
    );
    return 0;
  }

  const closed: SessionView[] = [];
  const forgotten: string[] = [];
  let skipped = 0;
  for (const session of targets) {
    if (terminal(session)) {
      if (!options.forget) {
        skipped += 1;
        continue;
      }
      await conn.request<ForgetResult>("sessions.forget", {
        sessionId: session.id,
      });
      forgotten.push(session.id);
      continue;
    }
    const result = await conn.request<CloseResult>("sessions.close", {
      sessionId: session.id,
      force: options.force,
    });
    if (result.wasTerminal) skipped += 1;
    else closed.push(result.session);
  }

  if (ctx.json) {
    writeJson({
      count: closed.length,
      forgotten: forgotten.length,
      forgottenIds: forgotten,
      skipped,
      sessions: closed,
    });
    return 0;
  }
  for (const session of closed) out(`closed ${sessionLabel(ctx, session)}`);
  for (const id of forgotten) out(`forgot ${ctx.style.bold(id)}`);
  out(
    `closed ${closed.length} · forgot ${forgotten.length} · skipped ${skipped}`,
  );
  return 0;
}

export async function cmdPermit(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "option", type: "string", valueName: "ID" },
    { name: "allow", type: "boolean" },
    { name: "deny", type: "boolean" },
    { name: "always", type: "boolean" },
    { name: "all-pending", type: "boolean" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "tree", type: "boolean" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "idle", type: "duration", valueName: "DUR" },
    { name: "except-self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "permit")) return 0;
  expectPositionals(parsed, "permit", 0, 1);

  const optionFlag = stringOption(parsed, "option");
  const wantsAllow = booleanOption(parsed, "allow") === true;
  const wantsDeny = booleanOption(parsed, "deny") === true;
  const chosenFlags = [optionFlag !== undefined, wantsAllow, wantsDeny].filter(
    Boolean,
  ).length;
  if (chosenFlags === 0) {
    throw usageError("choose --allow, --deny, or --option <id>");
  }
  if (chosenFlags > 1) {
    throw usageError("choose exactly one of --allow, --deny, --option");
  }
  const always = booleanOption(parsed, "always") ?? false;
  if (always && !wantsAllow) {
    throw usageError("--always must be used with --allow");
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  const selectorFlags = {
    root: stringOption(parsed, "root"),
    statuses: parseStatuses(stringOption(parsed, "status")),
    idle: numberOption(parsed, "idle"),
    exceptSelf: booleanOption(parsed, "except-self") === true,
  };
  const tree = booleanOption(parsed, "tree") === true;
  if (tree) {
    if (selectorFlags.root !== undefined) {
      throw usageError("permit: choose --root or --tree, not both");
    }
    if (parsed.positionals.length !== 1) {
      throw usageError("permit: --tree takes exactly one session id");
    }
    selectorFlags.root = parsed.positionals[0]!;
  }
  const allPending = booleanOption(parsed, "all-pending") === true;

  if (allPending || selectorsUsed(selectorFlags)) {
    if (booleanOption(parsed, "self") === true) {
      throw usageError("permit: selectors and --self are exclusive");
    }
    if (parsed.positionals.length > 0 && !tree) {
      throw usageError("permit: selector flags take no session ids");
    }
    const selected = await selectSessions(conn, ctx, selectorFlags);
    const pending = selected.filter(
      (session) => !isTerminal(session) && session.pendingPermission !== null,
    );
    if (pending.length === 0) {
      if (ctx.json) writeJson({ count: 0, resolved: [], failed: [] });
      else out("no pending permissions matched");
      return 0;
    }

    const resolved: PermitResult[] = [];
    const failed: { sessionId: string; message: string }[] = [];
    for (const session of pending) {
      const permission = session.pendingPermission!;
      try {
        const optionId = choosePermitOption(
          permission,
          optionFlag,
          wantsAllow,
          always,
        );
        const result = await conn.request<PermitResult>("sessions.permit", {
          sessionId: session.id,
          requestId: permission.requestId,
          optionId,
          ...(always ? { always: true } : {}),
        });
        resolved.push(result);
      } catch (error) {
        failed.push({
          sessionId: session.id,
          message: String((error as Error).message ?? error),
        });
      }
    }

    if (ctx.json) {
      writeJson({ count: resolved.length, resolved, failed });
      return failed.length > 0 ? 1 : 0;
    }
    for (const result of resolved) {
      out(
        `${styleStatus(result.session.status, ctx.style)} ${sessionLabel(ctx, result.session)} — ${result.optionId}`,
      );
    }
    for (const failure of failed) {
      out(ctx.style.yellow(`${failure.sessionId}: ${failure.message}`));
    }
    out(
      `permitted ${resolved.length} session${resolved.length === 1 ? "" : "s"}` +
        (failed.length > 0 ? ` · ${failed.length} failed` : ""),
    );
    return failed.length > 0 ? 1 : 0;
  }

  const sessionId = resolveTarget(parsed, "permit", "selfDefault");
  const current = await conn.request<GetResult>("sessions.get", { sessionId });
  const permission = current.session.pendingPermission;
  if (!permission) {
    throw new HlaoError(
      "no_pending_permission",
      `session ${current.session.id} has no pending permission`,
    );
  }

  const optionId = choosePermitOption(permission, optionFlag, wantsAllow, always);
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
      (permission.title ? ctx.style.dim(` · ${sanitize(permission.title)}`) : "") +
      (always ? ctx.style.dim(" · future requests will be allowed automatically") : ""),
  );
  return 0;
}

function choosePermitOption(
  permission: NonNullable<SessionView["pendingPermission"]>,
  optionId: string | undefined,
  wantsAllow: boolean,
  always: boolean,
): string {
  if (optionId !== undefined) {
    if (!permission.options.some((candidate) => candidate.optionId === optionId)) {
      throw new HlaoError(
        "bad_option",
        `permission option "${optionId}" was not offered`,
        { options: permission.options },
      );
    }
    return optionId;
  }
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
  return option.optionId;
}

export async function cmdMode(args: string[]): Promise<number> {
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

export async function cmdPolicy(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "tree", type: "boolean" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "idle", type: "duration", valueName: "DUR" },
    { name: "except-self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "policy")) return 0;
  const selfUsed = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();
  const positionals = parsed.positionals;
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  const selectorFlags = {
    root: stringOption(parsed, "root"),
    statuses: parseStatuses(stringOption(parsed, "status")),
    idle: numberOption(parsed, "idle"),
    exceptSelf: booleanOption(parsed, "except-self") === true,
  };
  const tree = booleanOption(parsed, "tree") === true;
  if (tree) {
    if (selectorFlags.root !== undefined) {
      throw usageError("policy: choose --root or --tree, not both");
    }
    if (positionals.length !== 2) {
      throw usageError("policy: --tree takes a session id and a policy");
    }
    selectorFlags.root = positionals[0]!;
  }

  if (selectorsUsed(selectorFlags)) {
    if (selfUsed) {
      throw usageError("policy: selectors and --self are exclusive");
    }
    const policyToken = tree ? positionals[1] : positionals[0];
    const bulkPolicy = parsePolicy(policyToken);
    if (bulkPolicy === undefined) {
      throw usageError("policy: selectors take one allow|ask|deny policy");
    }
    if (!tree && positionals.length !== 1) {
      throw usageError("policy: selector flags take exactly one policy");
    }
    const selected = (
      await selectSessions(conn, ctx, selectorFlags)
    ).filter((session) => !isTerminal(session));
    if (selected.length === 0) {
      if (ctx.json) writeJson({ count: 0, sessions: [] });
      else out("no sessions matched the selectors");
      return 0;
    }
    const updated: SessionView[] = [];
    for (const session of selected) {
      const result = await conn.request<SetPolicyResult>(
        "sessions.set_policy",
        { sessionId: session.id, permissionPolicy: bulkPolicy },
      );
      updated.push(result.session);
    }
    if (ctx.json) {
      writeJson({ count: updated.length, sessions: updated });
      return 0;
    }
    for (const session of updated) {
      out(
        `policy of ${sessionLabel(ctx, session)}: ${ctx.style.cyan(session.permissionPolicy)}`,
      );
    }
    out(
      `updated ${updated.length} session${updated.length === 1 ? "" : "s"}`,
    );
    return 0;
  }

  let sessionId: string;
  let policy: PermissionPolicy | undefined;

  if (selfUsed) {
    if (!caller) throw usageError("policy: --self requires HLAO_SESSION_ID");
    if (positionals.length > 1) {
      throw usageError("policy: --self takes at most one policy");
    }
    sessionId = caller;
    policy = parsePolicy(positionals[0]);
  } else if (positionals.length === 0) {
    if (!caller) throw usageError("policy needs a session id");
    sessionId = caller;
  } else if (positionals.length === 1) {
    const candidate = parsePolicy(positionals[0]);
    if (candidate !== undefined && caller) {
      sessionId = caller;
      policy = candidate;
    } else {
      sessionId = positionals[0]!;
    }
  } else if (positionals.length === 2) {
    sessionId = positionals[0]!;
    policy = parsePolicy(positionals[1]);
    if (policy === undefined) {
      throw usageError("policy must be allow, ask, or deny");
    }
  } else {
    throw usageError("policy takes a session id and one optional allow|ask|deny");
  }

  if (policy === undefined) {
    const got = await conn.request<GetResult>("sessions.get", { sessionId });
    if (ctx.json) {
      writeJson({ session: got.session });
      return 0;
    }
    out(
      `policy of ${sessionLabel(ctx, got.session)}: ${ctx.style.cyan(
        got.session.permissionPolicy,
      )}`,
    );
    return 0;
  }

  const result = await conn.request<SetPolicyResult>("sessions.set_policy", {
    sessionId,
    permissionPolicy: policy,
  });
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    `policy of ${sessionLabel(ctx, result.session)}: ${ctx.style.cyan(
      result.session.permissionPolicy,
    )}`,
  );
  if (result.session.pendingPermission) {
    out(
      ctx.style.dim(
        `still pending; run "hlao permit ${result.session.id} --allow" to answer it`,
      ),
    );
  }
  return 0;
}

export async function cmdOption(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "option")) return 0;
  const selfUsed = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();
  const positionals = parsed.positionals;
  let sessionId: string;
  let configId: string | undefined;
  let value: string | undefined;

  if (selfUsed) {
    if (!caller) throw usageError("option: --self requires HLAO_SESSION_ID");
    sessionId = caller;
    if (positionals.length === 2) {
      configId = positionals[0]!;
      value = positionals[1]!;
    } else if (positionals.length !== 0) {
      throw usageError("option --self takes either no arguments or <key> <value>");
    }
  } else if (positionals.length === 0) {
    if (!caller) throw usageError("option needs a session id");
    sessionId = caller;
  } else if (positionals.length === 1) {
    sessionId = positionals[0]!;
  } else if (positionals.length === 3) {
    sessionId = positionals[0]!;
    configId = positionals[1]!;
    value = positionals[2]!;
  } else {
    throw usageError(
      "option takes <id>, <id> <key> <value>, or --self <key> <value>",
    );
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  if (configId === undefined || value === undefined) {
    const got = await conn.request<GetResult>("sessions.get", { sessionId });
    if (ctx.json) {
      writeJson({ session: got.session });
      return 0;
    }
    const options = got.session.configOptions;
    if (!options || options.length === 0) {
      out(
        ctx.style.dim(
          `backend "${got.session.backend}" advertises no config options`,
        ),
      );
      return 0;
    }
    out(`config options for ${sessionLabel(ctx, got.session)}`);
    for (const option of options) {
      out(
        `  ${ctx.style.bold(option.id.padEnd(16))} ${sanitize(option.name)} ` +
          ctx.style.dim(`[${option.type}]`) +
          ` current ${ctx.style.cyan(String(option.currentValue))}` +
          (option.category ? ctx.style.dim(` · ${option.category}`) : ""),
      );
      for (const candidate of option.values) {
        out(
          `    ${candidate.value.padEnd(16)} ${sanitize(candidate.name)}` +
            (candidate.group ? ctx.style.dim(` (${candidate.group})`) : "") +
            (candidate.description
              ? ctx.style.dim(` — ${sanitize(candidate.description)}`)
              : ""),
        );
      }
    }
    return 0;
  }

  const result = await conn.request<SetConfigOptionResult>(
    "sessions.set_config_option",
    { sessionId, configId, value },
  );
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  const current = result.session.configOptions?.find(
    (option) => option.id === configId,
  );
  out(
    `option ${configId} of ${sessionLabel(ctx, result.session)}: ${ctx.style.cyan(
      String(current?.currentValue ?? value),
    )}`,
  );
  return 0;
}

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

function parsePolicy(value: string | undefined): PermissionPolicy | undefined {
  return value === "allow" || value === "ask" || value === "deny"
    ? value
    : undefined;
}

export async function cmdRename(args: string[]): Promise<number> {
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

