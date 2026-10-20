
import { HlaoError } from "../../errors.js";
import type { GetResult, SetModeResult } from "../../protocol.js";

import { booleanOption, expectPositionals, parseArgs, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, sessionLabel, writeJson } from "../context.js";
import { helpRequested } from "../help.js";

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
