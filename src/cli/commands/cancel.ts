import { isTerminalStatus } from "../../protocol.js";


import type { CancelResult, SessionView, WaitResult } from "../../protocol.js";
import { formatDuration } from "../../time.js";
import { booleanOption, expectPositionals, numberOption, parseArgs, stringOption, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, resolveTarget, sessionLabel, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { styleStatus } from "../render.js";
import { parseStatuses } from "./list-filters.js";
import { isTerminal, selectSessions, selectorsUsed, type SelectorFlags } from "./selectors.js";

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

  const selectorFlags: SelectorFlags = {
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
    selectorFlags.tree = parsed.positionals[0]!;
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
  if (isTerminalStatus(result.session.status)) {
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
