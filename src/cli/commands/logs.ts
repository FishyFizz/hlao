import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

import { HlaoError } from "../../errors.js";

import { logPath } from "../../paths.js";

import { booleanOption, expectPositionals, numberOption, parseArgs, usageError } from "../args.js";
import { COMMON, contextFrom, out, sleepMs, writeJson, writeJsonLine, type CommandContext } from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";

export async function cmdLogs(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "lines", short: "n", type: "number", valueName: "N" },
    { name: "follow", short: "f", type: "boolean" },
    { name: "raw", type: "boolean" },
  ]);
  if (helpRequested(parsed, "logs")) return 0;
  expectPositionals(parsed, "logs", 0, 0);
  const ctx = contextFrom(parsed);
  const file = logPath(ctx.home);
  const requested = numberOption(parsed, "lines");
  if (requested !== undefined && requested < 0) {
    throw usageError("--lines must be zero or greater");
  }
  const follow = booleanOption(parsed, "follow") === true;
  const raw = booleanOption(parsed, "raw") === true;
  const limit = requested ?? 50;

  let exists = existsSync(file);
  let content = "";
  if (exists) {
    try {
      content = readFileSync(file, "utf8");
    } catch (error) {
      throw new HlaoError(
        "internal",
        `cannot read ${file}: ${(error as Error).message}`,
      );
    }
  }
  const lines = splitLines(content);
  const initial = limit === 0 ? lines : lines.slice(-limit);
  if (ctx.json && !follow) {
    writeJson({ path: file, lines: initial });
  } else {
    emitLogLines(ctx, initial, file, exists, raw);
  }
  if (!follow) return 0;

  if (!exists) {
    if (!ctx.json) out(ctx.style.dim(`waiting for ${file}…`));
    while (!existsSync(file)) await sleepMs(250);
    exists = true;
  }

  let offset = exists ? byteLength(content) : 0;
  for (;;) {
    await sleepMs(400);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size === offset) continue;
    let chunk: string;
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const handle = openSync(file, "r");
      try {
        readSync(handle, buffer, 0, length, offset);
      } finally {
        closeSync(handle);
      }
      chunk = buffer.toString("utf8");
    } catch {
      continue;
    }
    offset = size;
    emitLogLines(ctx, splitLines(chunk), file, true, raw);
  }
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function emitLogLines(
  ctx: CommandContext,
  lines: string[],
  file: string,
  exists: boolean,
  raw: boolean,
): void {
  if (ctx.json) {
    for (const line of lines) {
      writeJsonLine({ path: file, line });
    }
    return;
  }
  if (lines.length === 0) {
    if (!exists) out(ctx.style.dim(`no supervisor log at ${file}`));
    return;
  }
  // Adapter text can reach the log; strip terminal controls unless --raw.
  for (const line of lines) out(raw ? line : sanitize(line));
}
