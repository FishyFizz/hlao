import { HlaoError } from "../../errors.js";
import type {
  GetResult,
  PermitResult,
  PermissionView,
  SessionView,
} from "../../protocol.js";

import { booleanOption, expectPositionals, numberOption, parseArgs, stringOption, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, resolveTarget, sessionLabel, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize, styleStatus } from "../render.js";
import { parseStatuses } from "./list-filters.js";
import { isTerminal, selectSessions, selectorsUsed, type SelectorFlags } from "./selectors.js";

export async function cmdPermit(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "option", type: "string", valueName: "ID" },
    { name: "allow", type: "boolean" },
    { name: "deny", type: "boolean" },
    { name: "always", type: "boolean" },
    { name: "request", type: "string", valueName: "REQUEST" },
    { name: "all-pending", type: "boolean" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "tree", type: "boolean" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "idle", type: "duration", valueName: "DUR" },
    { name: "except-self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "permit")) return 0;
  expectPositionals(parsed, "permit", 0, 1);

  // Answering a request is operator-only. The supervisor enforces it; this
  // early check keeps an agent from mistaking its own answer for progress.
  if (process.env.HLAO_SESSION_ID?.trim()) {
    throw new HlaoError(
      "operator_only",
      "only an operator shell without HLAO_SESSION_ID may answer a permission request; report the blocker to the operator",
    );
  }

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
  const always = booleanOption(parsed, "always") === true;
  if (always && optionFlag !== undefined) {
    throw usageError("--always selects the provider's always option; combine it with --allow or --deny, not --option");
  }
  if (always && !wantsAllow && !wantsDeny) {
    throw usageError("--always must be used with --allow or --deny");
  }
  const requestFilter = stringOption(parsed, "request");

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  const selectorFlags: SelectorFlags = {
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
    selectorFlags.tree = parsed.positionals[0]!;
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
      (session) => !isTerminal(session) && session.pendingPermissions.length > 0,
    );
    if (pending.length === 0) {
      if (ctx.json) writeJson({ count: 0, resolved: [], failed: [] });
      else out("no pending permissions matched");
      return 0;
    }

    const resolved: PermitResult[] = [];
    const failed: { sessionId: string; requestId: string; message: string }[] = [];
    for (const session of pending) {
      for (const permission of session.pendingPermissions) {
        if (requestFilter !== undefined && permission.requestId !== requestFilter) {
          continue;
        }
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
          });
          resolved.push(result);
        } catch (error) {
          failed.push({
            sessionId: session.id,
            requestId: permission.requestId,
            message: String((error as Error).message ?? error),
          });
        }
      }
    }

    if (resolved.length === 0 && failed.length === 0) {
      if (ctx.json) writeJson({ count: 0, resolved: [], failed: [] });
      else out(`no pending permission with request id ${requestFilter}`);
      return 0;
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
      out(
        ctx.style.yellow(
          `${failure.sessionId}/${failure.requestId}: ${failure.message}`,
        ),
      );
    }
    out(
      `permitted ${resolved.length} request${resolved.length === 1 ? "" : "s"}` +
        (failed.length > 0 ? ` · ${failed.length} failed` : ""),
    );
    return failed.length > 0 ? 1 : 0;
  }

  const sessionId = resolveTarget(parsed, "permit", "selfDefault");
  const current = await conn.request<GetResult>("sessions.get", { sessionId });
  const permission = selectPending(current.session, requestFilter);
  const optionId = choosePermitOption(
    permission,
    optionFlag,
    wantsAllow,
    always,
  );
  const result = await conn.request<PermitResult>("sessions.permit", {
    sessionId: current.session.id,
    requestId: permission.requestId,
    optionId,
  });

  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  const option = permission.options.find((candidate) => candidate.optionId === optionId);
  out(
    `${styleStatus(result.session.status, ctx.style)} ${sessionLabel(ctx, result.session)} — ` +
      `${option?.kind ?? "selected"} ${optionId}` +
      (permission.title ? ctx.style.dim(` · ${sanitize(permission.title)}`) : ""),
  );
  return 0;
}

/** Pick the request to answer, or explain why the command is ambiguous. */
function selectPending(
  session: SessionView,
  requestId: string | undefined,
): PermissionView {
  const pending = session.pendingPermissions;
  if (pending.length === 0) {
    throw new HlaoError(
      "no_pending_permission",
      `session ${session.id} has no pending permission`,
    );
  }
  if (requestId !== undefined) {
    const found = pending.find((entry) => entry.requestId === requestId);
    if (!found) {
      throw new HlaoError(
        "no_pending_permission",
        `no pending permission with request id ${requestId}`,
        { requestIds: pending.map((entry) => entry.requestId) },
      );
    }
    return found;
  }
  if (pending.length > 1) {
    throw new HlaoError(
      "bad_request",
      `session ${session.id} has ${pending.length} pending permission requests; pass --request <id> (${pending
        .map((entry) => entry.requestId)
        .join(", ")}) or --all-pending`,
      { requestIds: pending.map((entry) => entry.requestId) },
    );
  }
  return pending[0]!;
}

/**
 * `--always` is a provider option selector, never a policy mutation:
 * `--allow --always` requires `allow_always`, `--deny --always` requires
 * `reject_always`, and a missing kind is `bad_option` with no fallback.
 */
function choosePermitOption(
  permission: PermissionView,
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
  const kinds = always
    ? [wantsAllow ? "allow_always" : "reject_always"]
    : wantsAllow
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = permission.options.find((candidate) => candidate.kind === kind);
    if (option) return option.optionId;
  }
  throw new HlaoError(
    "bad_option",
    always
      ? `this permission request offers no ${
          wantsAllow ? "allow_always" : "reject_always"
        } option; use --option to name one exactly`
      : `no ${wantsAllow ? "allow" : "deny"} option was offered; use --option`,
    { options: permission.options },
  );
}
