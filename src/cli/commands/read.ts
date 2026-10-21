import { isTerminalStatus } from "../../protocol.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupervisorConnection } from "../../client.js";
import { HlaoError } from "../../errors.js";
import type {
  EventType,
  ReadResult,
  WaitResult,
} from "../../protocol.js";
import { EVENT_TYPES } from "../../protocol.js";
import {
  booleanOption,
  expectPositionals,
  multipleOption,
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
  withProgress,
  writeJson,
  writeJsonLine,
  type CommandContext,
} from "../context.js";
import { helpRequested } from "../help.js";
import { exportAll, exportSession } from "./exporting.js";
import {
  renderEvents,
  renderReadResult,
} from "../render.js";
import { parseTimeBound, toIsoTimestamp } from "../time-args.js";

// Read and export: bounded pages, follow, and retained-history export.

/**
 * Export the full retained history, not one bounded page. History is lost on
 * `down`, so this is the supported recovery path; it reports truncation when
 * the log had already evicted events.
 */
export async function cmdExport(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "all", type: "boolean" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "raw", type: "boolean" },
    { name: "jsonl", type: "boolean" },
    { name: "out", type: "path", valueName: "FILE" },
  ]);
  if (helpRequested(parsed, "export")) return 0;
  const all = booleanOption(parsed, "all") === true;
  expectPositionals(parsed, "export", all ? 0 : 0, all ? 0 : 1);

  const ctx = contextFrom(parsed);
  if (ctx.json && booleanOption(parsed, "jsonl") === true) {
    throw usageError("choose --json or --jsonl");
  }
  if (ctx.jsonEnvelope && booleanOption(parsed, "jsonl") === true) {
    throw usageError("--json=envelope cannot be combined with --jsonl");
  }
  const raw = booleanOption(parsed, "raw") === true;
  const jsonl = booleanOption(parsed, "jsonl") === true;
  const outFile = stringOption(parsed, "out");
  const since = numberOption(parsed, "since") ?? 0;
  const conn = await connect(ctx);

  if (all) {
    if (outFile === undefined) {
      throw usageError("export --all requires --out DIR");
    }
    const manifest = await exportAll(conn, resolve(outFile), {
      since,
      raw,
      jsonl,
    });
    const exported = manifest.sessions.length - manifest.failures;
    if (ctx.json) {
      writeJson(manifest);
    } else {
      out(
        `exported ${exported} of ${manifest.sessions.length} session${manifest.sessions.length === 1 ? "" : "s"} to ${outFile}` +
          (manifest.failures > 0
            ? ctx.style.red(` · ${manifest.failures} failed (see manifest.json)`)
            : ""),
      );
    }
    return manifest.failures > 0 ? 1 : 0;
  }

  const sessionId = resolveTarget(parsed, "export", "selfDefault");
  const payload = await exportSession(conn, sessionId, { since, raw });
  const { events, earliestRetainedSeq, truncated } = payload;

  if (jsonl) {
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    const text = body.length > 0 ? `${body}\n` : "";
    if (outFile !== undefined) {
      writeFileSync(resolve(outFile), text);
      if (!ctx.json) {
        out(
          `exported ${events.length} event${events.length === 1 ? "" : "s"} to ${outFile}`,
        );
      }
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  if (outFile !== undefined) {
    writeFileSync(resolve(outFile), `${JSON.stringify(payload, null, 2)}\n`);
    if (ctx.json) {
      writeJson(payload);
    } else {
      out(
        `exported ${events.length} event${events.length === 1 ? "" : "s"} to ${outFile}` +
          (truncated
            ? ctx.style.dim(` · history begins at seq ${earliestRetainedSeq}`)
            : ""),
      );
    }
    return 0;
  }

  // Without a file, JSON on stdout keeps `hlao export <id> > history.json` safe.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

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

  const rawTypes = multipleOption(parsed, "type");
  for (const type of rawTypes) {
    if (!(EVENT_TYPES as readonly string[]).includes(type)) {
      throw usageError(
        `unknown event type "${type}" — known types: ${EVENT_TYPES.join(", ")}`,
      );
    }
  }
  const types = rawTypes.length > 0 ? (rawTypes as EventType[]) : undefined;
  const grep = stringOption(parsed, "grep");
  if (grep === "") throw usageError("--grep needs text");
  const regex = booleanOption(parsed, "regex") === true;
  if (regex && grep === undefined) {
    throw usageError("--regex requires --grep");
  }
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

interface FollowOptions {
  since?: number;
  limit?: number;
  raw: boolean;
  types?: EventType[];
  turn?: number;
  grep?: string;
  afterAt?: string;
  regex: boolean;
  context?: number;
  verbose: boolean;
  timestamps: boolean;
  jsonl: boolean;
  jsonlPage: boolean;
  failOnError: boolean;
  filtered: boolean;
}

/** The one-line `--jsonl-page` metadata record, shared by page and follow. */
function jsonlPageLine(result: ReadResult): string {
  return `${JSON.stringify({
    page: {
      sessionId: result.session.id,
      earliestRetainedSeq: result.earliestRetainedSeq,
      lastSeq: result.lastSeq,
      nextSeq: result.nextSeq,
      nextBefore: result.nextBefore,
      hasMore: result.hasMore,
      truncated: result.truncated,
    },
  })}\n`;
}

/**
 * A caller-owned watch loop: read a page, then one-shot wait for a change.
 * The supervisor owns no timer; closing the CLI aborts the pending wait.
 */
async function followRead(
  conn: SupervisorConnection,
  ctx: CommandContext,
  sessionId: string,
  options: FollowOptions,
): Promise<number> {
  let since = options.since;
  let first = true;
  for (;;) {
    const result = await conn.request<ReadResult>("sessions.read", {
      sessionId,
      since,
      limit: options.limit,
      raw: options.raw,
      types: options.types,
      turn: options.turn,
      grep: options.grep,
      ...(options.afterAt !== undefined ? { afterAt: options.afterAt } : {}),
      ...(options.regex ? { regex: true } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
    });

    if (options.jsonl) {
      if (options.jsonlPage) {
        process.stdout.write(jsonlPageLine(result));
      }
      for (const event of result.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      if (result.truncated && first) {
        process.stderr.write(`hlao: history was evicted before #${result.earliestRetainedSeq}\n`);
      }
    } else if (ctx.json) {
      // One complete page per line: a stream consumer can parse without framing.
      writeJsonLine(result);
    } else if (first) {
      out(
        renderReadResult(result, ctx.style, "hlao", {
          verbose: options.verbose,
          fullTimestamps: options.timestamps,
          filtered: options.filtered,
        }),
      );
    } else {
      const lines = renderEvents(
        result.events,
        ctx.style,
        result.session.id,
        "hlao",
        {
          verbose: options.verbose,
          fullTimestamps: options.timestamps,
        },
      );
      if (lines.length > 0) out(lines.join("\n"));
      if (result.truncated) {
        out(
          ctx.style.yellow(
            `history was evicted before #${result.earliestRetainedSeq}`,
          ),
        );
      }
    }
    first = false;
    since = result.nextSeq;

    if (result.hasMore) continue;
    if (isTerminalStatus(result.session.status)) {
      return options.failOnError && result.session.status === "failed" ? 3 : 0;
    }

    await withProgress(
      `following ${result.session.id}`,
      conn.request<WaitResult>(
        "sessions.wait",
        {
          sessionId,
          until: "change",
          since: result.lastSeq,
          timeoutMs: 0,
        },
        { timeoutMs: 0 },
      ),
    );
  }
}
