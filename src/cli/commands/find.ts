import { isTerminalStatus } from "../../protocol.js";
import type { ListResult, EventType, EventView, ReadResult } from "../../protocol.js";
import { EVENT_TYPES } from "../../protocol.js";
import {
  booleanOption,
  expectPositionals,
  multipleOption,
  numberOption,
  parseArgs,
  usageError,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  out,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { sanitize } from "../render.js";

const PAGE_SIZE = 1_000;
const MAX_PAGES_PER_SESSION = 20;

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
  ]);
  if (helpRequested(parsed, "find")) return 0;
  expectPositionals(parsed, "find", 1, 1);

  const query = parsed.positionals[0]!;
  if (query.trim().length === 0) {
    throw usageError("find needs non-empty text");
  }
  const types = multipleOption(parsed, "type") as EventType[];
  for (const type of types) {
    if (!(EVENT_TYPES as readonly string[]).includes(type)) {
      throw usageError(
        `unknown event type "${type}" — known types: ${EVENT_TYPES.join(", ")}`,
      );
    }
  }
  const max = numberOption(parsed, "max") ?? 1_000;
  if (max < 1 || max > 10_000) {
    throw usageError("--max must be between 1 and 10000");
  }

  const ctx = contextFrom(parsed);
  const conn = await connect(ctx);
  const list = await conn.request<ListResult>("sessions.list", {
    includeClosed: true,
  });
  const sessions =
    booleanOption(parsed, "all") === true
      ? list.sessions
      : list.sessions.filter(
          (session) =>
            !isTerminalStatus(session.status),
        );

  const matches: { sessionId: string; event: EventView }[] = [];
  const capped: string[] = [];

  for (const session of sessions) {
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
        });
      } catch {
        // The session may have been forgotten between list and read.
        break;
      }

      for (const event of page.events) {
        matches.push({ sessionId: session.id, event });
        if (matches.length >= max) break;
      }
      if (matches.length >= max) {
        capped.push(session.id);
        break;
      }
      if (!page.hasMore) break;
      if (page.nextSeq <= since) break;
      since = page.nextSeq;
      if (pageNumber === MAX_PAGES_PER_SESSION - 1) {
        capped.push(session.id);
      }
    }
    if (matches.length >= max) break;
  }

  if (ctx.json) {
    writeJson({ query, count: matches.length, matches, capped });
    return 0;
  }
  if (matches.length === 0) {
    out(`no matches for "${sanitize(query)}"`);
    return 0;
  }
  for (const { sessionId, event } of matches) {
    const preview = sanitize(JSON.stringify(event.data ?? {}))
      .replace(/\s+/g, " ")
      .slice(0, 140);
    out(`${sessionId}  #${event.seq}  ${event.type}  ${preview}`);
  }
  const sessionCount = new Set(matches.map((match) => match.sessionId)).size;
  out(
    ctx.style.dim(
      `${matches.length} match${matches.length === 1 ? "" : "es"} in ${sessionCount} session${sessionCount === 1 ? "" : "s"}` +
        (capped.length > 0 ? ` · scan capped for ${capped.length} session${capped.length === 1 ? "" : "s"}` : ""),
    ),
  );
  return 0;
}
