
import { resolve } from "node:path";

import { loadConfig, mergeBackends, toAgentView } from "../../config.js";

import { expectPositionals, parseArgs, stringOption } from "../args.js";
import { COMMON, contextFrom, out, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { renderAgentTable } from "../render.js";

export async function cmdAgents(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "cwd", type: "path", valueName: "DIR" },
  ]);
  if (helpRequested(parsed, "agents")) return 0;
  expectPositionals(parsed, "agents", 0, 0);
  const ctx = contextFrom(parsed);
  // Local and non-mutating: `agents` never starts a supervisor.
  const loaded = loadConfig(ctx.home);
  if (loaded.error) throw loaded.error;
  const cwd = resolve(stringOption(parsed, "cwd") ?? process.cwd());
  const merged = mergeBackends(loaded.config.backends, cwd);
  const result = {
    agents: Object.values(merged)
      .map(toAgentView)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    renderAgentTable(
      result.agents,
      ctx.style,
      process.stdout.isTTY === true ? process.stdout.columns : undefined,
    ),
  );
  return 0;
}
