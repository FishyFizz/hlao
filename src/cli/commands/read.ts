import { writeFileSync } from "node:fs";
import { HlaoError } from "../../errors.js";
import type { ReadResult } from "../../protocol.js";
import {
  booleanOption,
  expectPositionals,
  numberOption,
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
  resolveTarget,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { renderReadResult } from "../render.js";
import { parseTimeBound, toIsoTimestamp } from "../time-args.js";
import { parseEventTypes, parseGrepFilter } from "../event-filters.js";
import { followRead, jsonlPageLine } from "./read-follow.js";

/** Read one bounded page, or follow a session's event stream. */
export async function cmdRead(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "before", type: "number", valueName: "SEQ" },
    { name: "limit", type: "number", valueName: "N" },
    { name: "type", type: "string", valueName: "TYPE", multiple: true },
    { name: "turn", type: "number", valueName: "N" },
    { name: "grep", type: "string", valueName: "TEXT" },
    { name: "regex", type: "boolean" },
    { name: "context", type: "number", valueName: "N" },
    { name: "after", type: "string", valueName: "TIME" },
    { name: "until", type: "string", valueName: "TIME" },
    { name: "raw", type: "boolean" },
    { name: "verbose", type: "boolean" },
    { name: "timestamps", type: "boolean" },
    { name: "follow", type: "boolean" },
    { name: "fail-on-error", type: "boolean" },
    { name: "jsonl", type: "boolean" },
    { name: "jsonl-page", type: "boolean" },
    { name: "out", type: "path", valueName: "FILE" },
  ]);
  if (helpRequested(parsed, "read")) return 0;
  expectPositionals(parsed, "read", 0, 1);

  const sessionId = resolveTarget(parsed, "read", "selfDefault");
  const ctx = contextFrom(parsed);
  const verbose = booleanOption(parsed, "verbose") === true;
  const raw = booleanOption(parsed, "raw") === true || verbose;
  const timestamps = booleanOption(parsed, "timestamps") === true;
  const follow = booleanOption(parsed, "follow") === true;
  const failOnError = booleanOption(parsed, "fail-on-error") === true;
  if (failOnError && !follow) {
    throw usageError("--fail-on-error requires --follow");
  }
  const jsonl = booleanOption(parsed, "jsonl") === true;
  const jsonlPage = booleanOption(parsed, "jsonl-page") === true;
  if (jsonlPage && !jsonl) {
    throw usageError("--jsonl-page requires --jsonl");
  }
  const outFile = stringOption(parsed, "out");
  if (follow && outFile !== undefined) {
    throw usageError("--out cannot be combined with --follow");
  }
  if (jsonl && ctx.json) {
    throw usageError("choose --json or --jsonl");
  }
  if (jsonl && ctx.jsonEnvelope) {
    throw usageError("--json=envelope cannot be combined with --jsonl");
  }
  if (jsonl && outFile !== undefined) {
    throw usageError("--out cannot be combined with --jsonl");
  }

  const since = numberOption(parsed, "since");
  const before = numberOption(parsed, "before");
  if (since !== undefined && before !== undefined) {
    throw usageError("--since and --before are mutually exclusive");
  }
  if (before !== undefined && follow) {
    throw usageError("--before cannot be combined with --follow");
  }
  const limit = numberOption(parsed, "limit");
  const turn = numberOption(parsed, "turn");
  if (turn !== undefined && turn < 0) throw usageError("--turn must not be negative");

  const rawTypes = parseEventTypes(parsed);
  const types = rawTypes.length > 0 ? rawTypes : undefined;
  const { grep, regex } = parseGrepFilter(parsed);
  const context = numberOption(parsed, "context");
  if (context !== undefined && (context < 0 || context > 20)) {
    throw usageError("--context must be between 0 and 20");
  }
  if (
    context !== undefined &&
    context > 0 &&
    grep === undefined &&
    types === undefined &&
    turn === undefined
  ) {
    throw usageError("--context needs --grep, --type, or --turn to be meaningful");
  }
  const now = Date.now();
  const afterRaw = stringOption(parsed, "after");
  const untilRaw = stringOption(parsed, "until");
  const afterAt = afterRaw === undefined ? undefined : parseTimeBound(afterRaw, "--after", now);
  const beforeAt = untilRaw === undefined ? undefined : parseTimeBound(untilRaw, "--until", now);
  if (afterAt !== undefined && beforeAt !== undefined && afterAt >= beforeAt) {
    throw usageError("--after must be earlier than --until");
  }
  if (beforeAt !== undefined && follow) {
    throw usageError("--until cannot be combined with --follow");
  }

  const conn = await connect(ctx);
  const filtered =
    types !== undefined ||
    turn !== undefined ||
    grep !== undefined ||
    afterAt !== undefined ||
    beforeAt !== undefined;
  if (types !== undefined || turn !== undefined || grep !== undefined) {
    await ensureCapability(conn, "read.filters", "read filters");
  }
  if (before !== undefined) {
    await ensureCapability(conn, "read.before", "read --before");
  }
  if (afterAt !== undefined || beforeAt !== undefined) {
    await ensureCapability(conn, "read.time", "read time filters");
  }
  if (regex) {
    await ensureCapability(conn, "read.regex", "read --regex");
  }
  if (context !== undefined && context > 0) {
    await ensureCapability(conn, "read.context", "read --context");
  }
  const afterIso = afterAt === undefined ? undefined : toIsoTimestamp(afterAt);
  const beforeIso = beforeAt === undefined ? undefined : toIsoTimestamp(beforeAt);

  if (follow) {
    return await followRead(conn, ctx, sessionId, {
      since,
      limit,
      raw,
      types,
      turn,
      grep,
      afterAt: afterIso,
      regex,
      context,
      verbose: verbose || raw,
      timestamps,
      jsonl,
      jsonlPage,
      failOnError,
      filtered,
    });
  }

  const result = await conn.request<ReadResult>("sessions.read", {
    sessionId,
    since,
    before,
    limit,
    raw,
    types,
    turn,
    grep,
    ...(afterIso !== undefined ? { afterAt: afterIso } : {}),
    ...(beforeIso !== undefined ? { beforeAt: beforeIso } : {}),
    ...(regex ? { regex: true } : {}),
    ...(context !== undefined ? { context } : {}),
  });

  if (outFile !== undefined) {
    try {
      writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      throw new HlaoError(
        "bad_request",
        `cannot write ${outFile}: ${(error as Error).message}`,
      );
    }
    if (ctx.json) process.stderr.write(`hlao: wrote ${outFile}\n`);
  }

  if (jsonl) {
    if (jsonlPage) process.stdout.write(jsonlPageLine(result));
    for (const event of result.events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    return 0;
  }
  if (ctx.json) {
    writeJson(result);
    return 0;
  }
  out(
    renderReadResult(result, ctx.style, "hlao", {
      verbose: verbose || raw,
      fullTimestamps: timestamps,
      filtered,
    }),
  );
  if (outFile !== undefined) {
    out(ctx.style.dim(`saved ${outFile}`));
  }
  return 0;
}
