
import { HlaoError } from "../../errors.js";
import type { GetResult, PermitResult, SessionView } from "../../protocol.js";

import { booleanOption, expectPositionals, numberOption, parseArgs, stringOption, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, resolveTarget, sessionLabel, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize, styleStatus } from "../render.js";
import { parseStatuses } from "./list.js";
import { isTerminal, selectSessions, selectorsUsed, type SelectorFlags } from "./selectors.js";

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
