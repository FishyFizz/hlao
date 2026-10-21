import { isTerminalStatus } from "../../protocol.js";
import type { ListResult, EventView, ReadResult } from "../../protocol.js";
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
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";
import { parseTimeBound, toIsoTimestamp } from "../time-args.js";
import { parseEventTypes } from "../event-filters.js";
import { labelOf } from "./session-view.js";

const PAGE_SIZE = 1_000;
const MAX_PAGES_PER_SESSION = 20;
const SNIPPET_CHARS = 140;
const LABEL_CHARS = 24;

interface Match {
  sessionId: string;
  sessionLabel: string;
  event: EventView;
  before: EventView[];
  after: EventView[];
}

interface ScanError {
  sessionId: string;
  message: string;
}

/**
 * Cross-session search. It is a bounded client loop over `sessions.list` and
 * `sessions.read --grep`; the supervisor gains no search method and no index.
 */
export async function cmdFind(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "all", type: "boolean" },
    { name: "type", type: "string", valueName: "TYPE", multiple: true },
    { name: "max", type: "number", valueName: "N" },
    { name: "after", type: "string", valueName: "TIME" },
    { name: "until", type: "string", valueName: "TIME" },
    { name: "regex", type: "boolean" },
    { name: "context", type: "number", valueName: "N" },
  ]);
  if (helpRequested(parsed, "find")) return 0;
  expectPositionals(parsed, "find", 1, 1);

  const query = parsed.positionals[0]!;
  if (query.trim().length === 0) {
    throw usageError("find needs non-empty text");
  }
  const types = parseEventTypes(parsed);
  const max = numberOption(parsed, "max") ?? 1_000;
  if (max < 1 || max > 10_000) {
    throw usageError("--max must be between 1 and 10000");
  }
  const regex = booleanOption(parsed, "regex") === true;
  if (regex) {
    try {
      new RegExp(query, "i");
    } catch (error) {
      throw usageError(
        `TEXT is not a valid regular expression: ${(error as Error).message}`,
      );
    }
  }
  const context = numberOption(parsed, "context") ?? 0;
  if (context < 0 || context > 20) {
    throw usageError("--context must be between 0 and 20");
  }
  const now = Date.now();
  const afterRaw = stringOption(parsed, "after");
  const untilRaw = stringOption(parsed, "until");
  const afterAt = afterRaw === undefined ? undefined : parseTimeBound(afterRaw, "--after", now);
  const beforeAt = untilRaw === undefined ? undefined : parseTimeBound(untilRaw, "--until", now);
  if (afterAt !== undefined && beforeAt !== undefined && afterAt >= beforeAt) {
    throw usageError("--after must be earlier than --until");
  }
  const afterIso = afterAt === undefined ? undefined : toIsoTimestamp(afterAt);
  const beforeIso = beforeAt === undefined ? undefined : toIsoTimestamp(beforeAt);

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  await ensureCapability(conn, "read.filters", "find");
  if (afterIso !== undefined || beforeIso !== undefined) {
    await ensureCapability(conn, "read.time", "find time filters");
  }
  if (regex) {
    await ensureCapability(conn, "read.regex", "find --regex");
  }
  if (context > 0) {
    await ensureCapability(conn, "read.context", "find --context");
  }

  const list = await conn.request<ListResult>("sessions.list", {
    includeClosed: true,
  });
  const sessions =
    booleanOption(parsed, "all") === true
      ? list.sessions
      : list.sessions.filter(
          (session) => !isTerminalStatus(session.status),
        );

  const matches: Match[] = [];
  const cappedByMax = new Set<string>();
  const cappedByPages = new Set<string>();
  const errors: ScanError[] = [];

  for (const session of sessions) {
    const sessionLabel = labelOf(session);
    let since = 0;
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SESSION; pageNumber += 1) {
      let page: ReadResult;
      try {
        page = await conn.request<ReadResult>("sessions.read", {
          sessionId: session.id,
          since,
          limit: PAGE_SIZE,
          grep: query,
          ...(types.length > 0 ? { types } : {}),
          ...(afterIso !== undefined ? { afterAt: afterIso } : {}),
          ...(beforeIso !== undefined ? { beforeAt: beforeIso } : {}),
          ...(regex ? { regex: true } : {}),
          ...(context > 0 ? { context } : {}),
        });
      } catch (error) {
        // The session may have been forgotten between list and read. Report it
        // instead of silently shortening the result set.
        errors.push({
          sessionId: session.id,
          message: (error as Error).message,
        });
        break;
      }

      const matched = new Set(
        page.matchedSeqs ?? page.events.map((event) => event.seq),
      );
      for (let index = 0; index < page.events.length; index += 1) {
        const event = page.events[index]!;
        if (!matched.has(event.seq)) continue;
        matches.push({
          sessionId: session.id,
          sessionLabel,
          event,
          before:
            context > 0
              ? page.events.slice(Math.max(0, index - context), index)
              : [],
          after:
            context > 0
              ? page.events.slice(index + 1, index + 1 + context)
              : [],
        });
        if (matches.length >= max) break;
      }
      if (matches.length >= max) {
        cappedByMax.add(session.id);
        break;
      }
      if (!page.hasMore) break;
      if (page.nextSeq <= since) break;
      since = page.nextSeq;
      if (pageNumber === MAX_PAGES_PER_SESSION - 1) {
        cappedByPages.add(session.id);
      }
    }
    if (matches.length >= max) break;
  }

  const capped = [...new Set([...cappedByMax, ...cappedByPages])];
  if (ctx.json) {
    writeJson({
      query,
      count: matches.length,
      matches,
      capped,
      cappedByMax: [...cappedByMax],
      cappedByPages: [...cappedByPages],
      errors,
    });
    return 0;
  }
  if (matches.length === 0) {
    out(`no matches for "${sanitize(query)}"`);
    reportScanProblems(ctx, cappedByMax, cappedByPages, errors);
    return 0;
  }
  for (const match of matches) {
    if (context > 0) {
      for (const event of match.before) {
        out(ctx.style.dim(`  ${contextLine(match.sessionId, event)}`));
      }
    }
    out(
      `${ctx.style.bold("›")} ${contextLine(match.sessionId, match.event, match.sessionLabel)}`,
    );
    if (context > 0) {
      for (const event of match.after) {
        out(ctx.style.dim(`  ${contextLine(match.sessionId, event)}`));
      }
    }
  }
  const sessionCount = new Set(matches.map((match) => match.sessionId)).size;
  out(
    ctx.style.dim(
      `${matches.length} match${matches.length === 1 ? "" : "es"} in ${sessionCount} session${sessionCount === 1 ? "" : "s"}`,
    ),
  );
  reportScanProblems(ctx, cappedByMax, cappedByPages, errors);
  return 0;
}

function contextLine(
  sessionId: string,
  event: EventView,
  sessionLabel?: string,
): string {
  const clock = formatClock(event.at);
  let label = "";
  if (sessionLabel !== undefined) {
    if (sessionLabel === sessionId) {
      label = `${sessionId}  `;
    } else {
      // Reserve room for "(id)" so the addressable handle is never the part
      // that gets cut off.
      const idText = `(${sessionId})`;
      const budget = Math.max(4, LABEL_CHARS - idText.length - 1);
      label = `${truncate(sessionLabel, budget)} ${idText}  `;
    }
  }
  return `${clock}  ${label}#${event.seq}  ${event.type}  ${snippet(event)}`;
}

function snippet(event: EventView): string {
  const data = event.data ?? {};
  const preferred = [
    "text",
    "title",
    "message",
    "content",
    "name",
    "reason",
    "status",
    "command",
  ].find((key) => typeof data[key] === "string" && (data[key] as string).length > 0);
  let text: string;
  if (preferred !== undefined) {
    text = data[preferred] as string;
  } else {
    try {
      text = JSON.stringify(data) ?? event.type;
    } catch {
      text = event.type;
    }
  }
  text = sanitize(text).replace(/\s+/g, " ").trim();
  if (text.length > SNIPPET_CHARS) {
    text = `${text.slice(0, SNIPPET_CHARS - 1)}…`;
  }
  return text;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "--:--:--";
  return date.toTimeString().slice(0, 8);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function reportScanProblems(
  ctx: ReturnType<typeof contextFrom>,
  cappedByMax: Set<string>,
  cappedByPages: Set<string>,
  errors: ScanError[],
): void {
  if (cappedByMax.size > 0) {
    out(
      ctx.style.dim(
        `stopped at --max while scanning ${cappedByMax.size} session${cappedByMax.size === 1 ? "" : "s"}`,
      ),
    );
  }
  if (cappedByPages.size > 0) {
    out(
      ctx.style.dim(
        `page cap reached for ${cappedByPages.size} session${cappedByPages.size === 1 ? "" : "s"}`,
      ),
    );
  }
  for (const error of errors) {
    out(ctx.style.dim(`could not read ${error.sessionId}: ${sanitize(error.message)}`));
  }
}
