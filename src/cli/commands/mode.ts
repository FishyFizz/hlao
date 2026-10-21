import type { SupervisorConnection } from "../../client.js";
import { HlaoError } from "../../errors.js";
import type { GetResult, SetModeResult } from "../../protocol.js";

import { booleanOption, expectPositionals, numberOption, parseArgs, stringOption, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, sessionLabel, writeJson, type CommandContext } from "../context.js";
import { helpRequested } from "../help.js";
import { parseStatuses } from "./list-filters.js";
import { isTerminal, selectSessions, selectorsUsed, type SelectorFlags } from "./selectors.js";

/**
 * Read or switch the provider's native mode. Reads are open to any caller;
 * setting one is operator-only. Bulk selectors replace the removed `policy`
 * bulk mode.
 */
export async function cmdMode(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "tree", type: "boolean" },
    { name: "status", type: "string", valueName: "STATUS" },
    { name: "idle", type: "duration", valueName: "DUR" },
    { name: "except-self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "mode")) return 0;
  const selfUsed = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();

  const selectorFlags: SelectorFlags = {
    root: stringOption(parsed, "root"),
    statuses: parseStatuses(stringOption(parsed, "status")),
    idle: numberOption(parsed, "idle"),
    exceptSelf: booleanOption(parsed, "except-self") === true,
  };
  const tree = booleanOption(parsed, "tree") === true;
  if (tree) {
    if (selectorFlags.root !== undefined) {
      throw usageError("mode: choose --root or --tree, not both");
    }
    if (parsed.positionals.length !== 2) {
      throw usageError("mode: --tree takes a subtree id and a mode id");
    }
    selectorFlags.tree = parsed.positionals[0]!;
  }

  const ctx = contextFrom(parsed);
  const refuseAgent = (): void => {
    if (caller) {
      throw new HlaoError(
        "operator_only",
        "only an operator shell without HLAO_SESSION_ID may change a provider mode; reads stay open",
      );
    }
  };

  if (selectorsUsed(selectorFlags)) {
    if (selfUsed) throw usageError("mode: selectors and --self are exclusive");
    const modeId = tree ? parsed.positionals[1] : parsed.positionals[0];
    if (modeId === undefined) {
      throw usageError("mode: selector flags take one mode id");
    }
    if (!tree && parsed.positionals.length !== 1) {
      throw usageError("mode: selector flags take exactly one mode id");
    }
    refuseAgent();
    const conn = await connect(ctx);
    return await setModeBulk(conn, ctx, selectorFlags, modeId);
  }

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

  if (modeId !== undefined) refuseAgent();
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

/** Apply one provider mode to every selected live session. */
async function setModeBulk(
  conn: SupervisorConnection,
  ctx: CommandContext,
  selectorFlags: SelectorFlags,
  modeId: string,
): Promise<number> {
  const selected = (await selectSessions(conn, ctx, selectorFlags)).filter(
    (session) => !isTerminal(session),
  );
  if (selected.length === 0) {
    if (ctx.json) writeJson({ count: 0, sessions: [], failed: [] });
    else out("no sessions matched the selectors");
    return 0;
  }

  const updated: SetModeResult["session"][] = [];
  const failed: { sessionId: string; message: string }[] = [];
  for (const session of selected) {
    try {
      const result = await conn.request<SetModeResult>("sessions.set_mode", {
        sessionId: session.id,
        modeId,
      });
      updated.push(result.session);
    } catch (error) {
      failed.push({
        sessionId: session.id,
        message: String((error as Error).message ?? error),
      });
    }
  }

  if (ctx.json) {
    writeJson({ count: updated.length, sessions: updated, failed });
    return failed.length > 0 ? 1 : 0;
  }
  for (const session of updated) {
    out(
      `mode of ${sessionLabel(ctx, session)}: ${ctx.style.cyan(
        session.modes?.currentModeId ?? modeId,
      )}`,
    );
  }
  for (const failure of failed) {
    out(ctx.style.yellow(`${failure.sessionId}: ${failure.message}`));
  }
  out(
    `updated ${updated.length} session${updated.length === 1 ? "" : "s"}` +
      (failed.length > 0 ? ` · ${failed.length} failed` : ""),
  );
  return failed.length > 0 ? 1 : 0;
}
