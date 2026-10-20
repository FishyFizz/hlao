import type { WaitResult } from "../../protocol.js";
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
  sessionLabel,
  withProgress,
  writeJson,
  type CommandContext,
} from "../context.js";
import { helpRequested } from "../help.js";
import { parseStatuses } from "./list.js";
import {
  renderPermission,
  sanitize,
  styleStatus,
} from "../render.js";
import { selectSessions, selectorsUsed } from "./selectors.js";

// Wait: one-shot awaits over one session or a selected set.
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


