import { resolve } from "node:path";

import type { ProviderSessionsResult } from "../../protocol.js";
import {
  booleanOption,
  expectPositionals,
  parseArgs,
  stringOption,
  usageError,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  ensureCapability,
  out,
  styleHint,
  withProgress,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { renderProviderSessionTable } from "../render.js";

/**
 * Provider-owned session catalog. This is a read of the adapter's ACP
 * `session/list`; the rows are not HLAO sessions. A live join annotates rows
 * this instance currently drives.
 */
export async function cmdProvider(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "cwd", type: "path", valueName: "DIR" },
    { name: "all", type: "boolean" },
    { name: "cursor", type: "string", valueName: "CURSOR" },
  ]);
  if (helpRequested(parsed, "provider")) return 0;
  const subcommand = parsed.positionals[0];
  if (subcommand !== "sessions") {
    throw usageError(
      subcommand === undefined
        ? "provider needs a subcommand: provider sessions <backend>"
        : `unknown provider subcommand "${subcommand}" — use "provider sessions <backend>"`,
    );
  }
  expectPositionals(parsed, "provider sessions", 2, 2);
  const backend = parsed.positionals[1]!;

  const ctx = contextFrom(parsed);
  const all = booleanOption(parsed, "all") === true;
  const cwdOption = stringOption(parsed, "cwd");
  if (all && cwdOption !== undefined) {
    throw usageError("--cwd and --all cannot be combined");
  }
  const cursor = stringOption(parsed, "cursor");
  const cwd = all ? undefined : resolve(cwdOption ?? process.cwd());

  const conn = await connect(ctx);
  await ensureCapability(conn, "backends.sessions", "provider sessions");
  const request = () =>
    conn.request<ProviderSessionsResult>(
      "backends.sessions",
      {
        backend,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
      { timeoutMs: 0 },
    );
  const result = ctx.json
    ? await request()
    : await withProgress(`listing ${backend} provider sessions`, request());

  if (ctx.json) {
    writeJson(result);
    return 0;
  }

  out(
    renderProviderSessionTable(
      result,
      ctx.style,
      process.stdout.isTTY === true ? process.stdout.columns : undefined,
    ),
  );
  if (result.sessions.length > 0) {
    out(
      styleHint(
        ctx,
        `hlao adopt ${result.backend} <provider-id> [--cwd DIR]   # take one into this instance`,
      ),
    );
  }
  return 0;
}
