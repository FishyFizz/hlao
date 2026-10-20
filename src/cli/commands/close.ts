import { isTerminalStatus } from "../../protocol.js";
import type { SupervisorConnection } from "../../client.js";

import type { CloseResult, ForgetResult, GetResult, ListResult, SessionView } from "../../protocol.js";

import { booleanOption, expectPositionals, numberOption, parseArgs, stringOption, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, resolveTarget, sessionLabel, writeJson, type CommandContext } from "../context.js";
import { helpRequested } from "../help.js";
import { renderTable, sanitize, styleStatus } from "../render.js";
import { parseStatuses } from "./list.js";
import { collectSubtree, resolveJobRoot } from "./selectors.js";

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
      (session) => !isTerminalStatus(session.status),
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
      isTerminalStatus(got.session.status);
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
    const root = resolveJobRoot(list.sessions, options.rootToken);
    targets = targets.filter((session) => session.rootId === root.id);
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
    isTerminalStatus(session.status);

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
