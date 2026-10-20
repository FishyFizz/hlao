

import type { RenameResult } from "../../protocol.js";

import { booleanOption, expectPositionals, parseArgs, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, writeJson } from "../context.js";
import { helpRequested } from "../help.js";

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
