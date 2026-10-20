

import type { GetResult } from "../../protocol.js";

import { booleanOption, expectPositionals, parseArgs } from "../args.js";
import { COMMON, connect, contextFrom, out, resolveTarget, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { renderSessionHeader, renderSessionState } from "../render.js";

export async function cmdGet(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "brief", type: "boolean" },
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
  out(
    booleanOption(parsed, "brief") === true
      ? renderSessionHeader(got.session, ctx.style)
      : renderSessionState(got.session, ctx.style),
  );
  return 0;
}
