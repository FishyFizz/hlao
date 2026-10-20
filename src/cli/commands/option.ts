

import type { GetResult, SetConfigOptionResult } from "../../protocol.js";

import { booleanOption, parseArgs, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, sessionLabel, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";

export async function cmdOption(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "option")) return 0;
  const selfUsed = booleanOption(parsed, "self") === true;
  const caller = process.env.HLAO_SESSION_ID?.trim();
  const positionals = parsed.positionals;
  let sessionId: string;
  let configId: string | undefined;
  let value: string | undefined;

  if (selfUsed) {
    if (!caller) throw usageError("option: --self requires HLAO_SESSION_ID");
    sessionId = caller;
    if (positionals.length === 2) {
      configId = positionals[0]!;
      value = positionals[1]!;
    } else if (positionals.length !== 0) {
      throw usageError("option --self takes either no arguments or <key> <value>");
    }
  } else if (positionals.length === 0) {
    if (!caller) throw usageError("option needs a session id");
    sessionId = caller;
  } else if (positionals.length === 1) {
    sessionId = positionals[0]!;
  } else if (positionals.length === 3) {
    sessionId = positionals[0]!;
    configId = positionals[1]!;
    value = positionals[2]!;
  } else {
    throw usageError(
      "option takes <id>, <id> <key> <value>, or --self <key> <value>",
    );
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);

  if (configId === undefined || value === undefined) {
    const got = await conn.request<GetResult>("sessions.get", { sessionId });
    if (ctx.json) {
      writeJson({ session: got.session });
      return 0;
    }
    const options = got.session.configOptions;
    if (!options || options.length === 0) {
      out(
        ctx.style.dim(
          `backend "${got.session.backend}" advertises no config options`,
        ),
      );
      return 0;
    }
    out(`config options for ${sessionLabel(ctx, got.session)}`);
    for (const option of options) {
      out(
        `  ${ctx.style.bold(option.id.padEnd(16))} ${sanitize(option.name)} ` +
          ctx.style.dim(`[${option.type}]`) +
          ` current ${ctx.style.cyan(String(option.currentValue))}` +
          (option.category ? ctx.style.dim(` · ${option.category}`) : ""),
      );
      for (const candidate of option.values) {
        out(
          `    ${candidate.value.padEnd(16)} ${sanitize(candidate.name)}` +
            (candidate.group ? ctx.style.dim(` (${candidate.group})`) : "") +
            (candidate.description
              ? ctx.style.dim(` — ${sanitize(candidate.description)}`)
              : ""),
        );
      }
    }
    return 0;
  }

  const result = await conn.request<SetConfigOptionResult>(
    "sessions.set_config_option",
    { sessionId, configId, value },
  );
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  const current = result.session.configOptions?.find(
    (option) => option.id === configId,
  );
  out(
    `option ${configId} of ${sessionLabel(ctx, result.session)}: ${ctx.style.cyan(
      String(current?.currentValue ?? value),
    )}`,
  );
  return 0;
}
