import { existsSync } from "node:fs";

import { loadConfig, redactConfig, toAgentView } from "../../config.js";
import { HlaoError } from "../../errors.js";

import { configPath } from "../../paths.js";
import { type ReloadResult } from "../../protocol.js";
import { formatDuration } from "../../time.js";

import { expectPositionals, parseArgs, usageError } from "../args.js";
import { COMMON, connect, contextFrom, out, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import { renderAgentTable } from "../render.js";

export async function cmdConfig(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "config")) return 0;
  expectPositionals(parsed, "config", 1, 1);
  const sub = parsed.positionals[0]!;
  if (!["show", "path", "validate"].includes(sub)) {
    throw usageError(`unknown config subcommand "${sub}" (show, path, validate)`);
  }
  const ctx = contextFrom(parsed);
  const file = configPath(ctx.home);

  if (sub === "path") {
    if (ctx.json) writeJson({ path: file });
    else out(file);
    return 0;
  }

  const loaded = loadConfig(ctx.home);
  if (sub === "validate") {
    if (loaded.error) throw loaded.error;
    if (ctx.json) writeJson({ ok: true, path: file });
    else out(`config OK · ${existsSync(file) ? file : "no config.json — built-in defaults"}`);
    return 0;
  }

  const redacted = redactConfig(loaded.config);
  if (ctx.json) {
    writeJson({
      path: file,
      exists: existsSync(file),
      config: redacted,
      error: loaded.error
        ? { code: loaded.error.code, message: loaded.error.message }
        : null,
    });
    return 0;
  }

  out(`config ${file}${existsSync(file) ? "" : " (missing; defaults)"}`);
  if (loaded.error) out(ctx.style.red(`invalid: ${loaded.error.message}`));
  out(`  permissionPolicy   ${redacted.permissionPolicy}`);
  out(`  waitTimeoutMs      ${formatDuration(redacted.waitTimeoutMs)}`);
  out(`  sendWaitTimeoutMs  ${formatDuration(redacted.sendWaitTimeoutMs)}`);
  out(`  startupTimeoutMs   ${formatDuration(redacted.startupTimeoutMs)}`);
  out(`  maxEventsPerSession ${redacted.maxEventsPerSession}`);
  out(`  maxEventLogBytes   ${redacted.maxEventLogBytes}`);
  out(`  maxEventBytes      ${redacted.maxEventBytes}`);
  out(`  retainClosedMs     ${formatDuration(redacted.retainClosedMs)}`);
  out("");
  out(renderAgentTable(Object.values(redacted.backends).map(toAgentView), ctx.style));
  return 0;
}

export async function cmdReload(args: string[]): Promise<number> {
  const parsed = parseArgs(args, COMMON);
  if (helpRequested(parsed, "reload")) return 0;
  expectPositionals(parsed, "reload", 0, 0);
  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const result = await conn.request<ReloadResult>("supervisor.reload", {});
  if (result.configError) {
    throw new HlaoError("config_invalid", result.configError, {
      configHash: result.configHash,
    });
  }
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    `config reloaded · new spawns use ${configPath(ctx.home)}; live sessions keep their settings`,
  );
  return 0;
}
