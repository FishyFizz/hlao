import type { EventLog } from "../events.js";
import type { EventView } from "../protocol.js";
import type { ReadOptions, ReadResult } from "./types.js";

/** Bound on a context-expanded read page; matches always survive the trim. */
const MAX_CONTEXT_EVENTS = 2_000;

/**
 * A read page plus its display context. Context is a display projection, not a
 * second filter: `limit` bounds the matches, neighbors are fetched around each
 * match and merged by seq, and the page cursors still advance by matches. A
 * neighbor may therefore repeat on the next page; that is deliberate, because
 * context must never hide a match.
 */
export function readPage(log: EventLog, options: ReadOptions): ReadResult {
  const base = log.read({
    since: options.since,
    before: options.before,
    limit: options.limit ?? 100,
    raw: options.raw ?? false,
    types: options.types,
    turn: options.turn,
    grep: options.grep,
    afterAt: options.afterAt,
    beforeAt: options.beforeAt,
    regex: options.regex,
  });
  const context = options.context ?? 0;
  if (context <= 0 || base.events.length === 0) return base;

  const matched = new Set(base.events.map((event) => event.seq));
  const bySeq = new Map<number, EventView>();
  for (const event of base.events) bySeq.set(event.seq, event);
  // A neighbor must not cross the caller's cursor: `since` is exclusive and
  // `before` is exclusive, even when a match sits at the page edge.
  const minSeq = options.since === undefined ? 0 : options.since + 1;
  const maxSeq = options.before === undefined ? Number.MAX_SAFE_INTEGER : options.before - 1;
  for (const match of base.events) {
    const window = log.read({
      before: match.seq + context + 1,
      limit: context * 2 + 1,
      raw: options.raw ?? false,
    });
    for (const event of window.events) {
      if (event.seq < minSeq || event.seq > maxSeq) continue;
      bySeq.set(event.seq, event);
    }
  }

  let events = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  if (events.length > MAX_CONTEXT_EVENTS) {
    const matches = events.filter((event) => matched.has(event.seq));
    const neighbors = events.filter((event) => !matched.has(event.seq));
    const room = Math.max(0, MAX_CONTEXT_EVENTS - matches.length);
    events = [...matches, ...neighbors.slice(0, room)].sort(
      (left, right) => left.seq - right.seq,
    );
  }
  return {
    ...base,
    events,
    matchedSeqs: [...matched].sort((left, right) => left - right),
  };
}
