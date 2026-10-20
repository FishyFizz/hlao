

import type { GetResult } from "../../protocol.js";

import { expectPositionals, parseArgs } from "../args.js";
import { COMMON, connect, contextFrom, out, resolveTarget, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { renderSessionHeader } from "../render.js";

export async function cmdGet(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
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
  out(renderSessionHeader(got.session, ctx.style));
  return 0;
}
