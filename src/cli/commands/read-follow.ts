import { isTerminalStatus } from "../../protocol.js";
import type {
  EventType,
  ReadResult,
  WaitResult,
} from "../../protocol.js";
import type { SupervisorConnection } from "../../client.js";
import {
  out,
  withProgress,
  writeJsonLine,
  type CommandContext,
} from "../context.js";
import { renderEvents, renderReadResult } from "../render.js";

export interface FollowOptions {
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
export function jsonlPageLine(result: ReadResult): string {
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
export async function followRead(
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
