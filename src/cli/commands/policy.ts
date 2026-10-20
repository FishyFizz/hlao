

import type { GetResult, PermissionPolicy, SessionView, SetPolicyResult } from "../../protocol.js";

import { booleanOption, numberOption, parseArgs, stringOption, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, sessionLabel, writeJson } from "../context.js";
import { helpRequested } from "../help.js";

import { parseStatuses } from "./list.js";
import { isTerminal, selectSessions, selectorsUsed } from "./selectors.js";

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

function parsePolicy(value: string | undefined): PermissionPolicy | undefined {
  return value === "allow" || value === "ask" || value === "deny"
    ? value
    : undefined;
}
