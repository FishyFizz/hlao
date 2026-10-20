import { nowIso } from "./time.js";
import type { EventType, EventView } from "./protocol.js";

export interface EventInput {
  type: EventType;
  turn?: number | null;
  data?: Record<string, unknown>;
}

export interface EventReadOptions {
  since?: number;
  before?: number;
  limit: number;
  raw: boolean;
  types?: EventType[];
  turn?: number;
  grep?: string;
}

export interface EventReadResult {
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;
  nextBefore: number | null;
  hasMore: boolean;
  truncated: boolean;
}

interface StoredEvent extends EventView {
  bytes: number;
}

export interface EventLogOptions {
  maxEvents: number;
  maxBytes: number;
  maxEventBytes: number;
  /** Bound on one read page. At least one event is always returned. */
  maxPageBytes?: number;
}

const DEFAULT_MAX_PAGE_BYTES = 8 * 1024 * 1024;

/**
 * A bounded, append-only, per-session event log.
 *
 * Sequence numbers are assigned here and are never reused. Eviction is visible
 * through `earliestRetainedSeq` so a reader is never silently missing events.
 */
export class EventLog {
  #events: StoredEvent[] = [];
  #bytes = 0;
  #nextSeq = 1;
  #lastSeq = 0;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #maxEventBytes: number;
  readonly #maxPageBytes: number;

  constructor(options: EventLogOptions) {
    this.#maxEvents = Math.max(1, options.maxEvents);
    this.#maxBytes = Math.max(1_024, options.maxBytes);
    this.#maxEventBytes = Math.max(1_024, options.maxEventBytes);
    this.#maxPageBytes = Math.max(1, options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES);
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get earliestRetainedSeq(): number {
    return this.#events[0]?.seq ?? this.#lastSeq + 1;
  }

  append(input: EventInput): EventView {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    this.#lastSeq = seq;

    const bounded = boundData(input.data ?? {}, this.#maxEventBytes);
    const event: StoredEvent = {
      seq,
      at: nowIso(),
      type: input.type,
      turn: input.turn ?? null,
      data: bounded,
      bytes: 0,
    };
    event.bytes = serializedSize(event);
    this.#events.push(event);
    this.#bytes += event.bytes;
    this.#trim();
    return toView(event, true);
  }

  read(options: EventReadOptions): EventReadResult {
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit)));
    const earliest = this.earliestRetainedSeq;
    const matches = createMatcher(options);

    if (options.before !== undefined) {
      return this.#readBackward(options.before, limit, matches, options.raw, earliest);
    }
    if (options.since !== undefined) {
      return this.#readForward(options.since, limit, matches, options.raw, earliest);
    }
    return this.#readTail(limit, matches, options.raw, earliest);
  }

  /** The newest page. `hasMore` is false by definition: nothing is newer than the tail. */
  #readTail(
    limit: number,
    matches: (event: StoredEvent) => boolean,
    raw: boolean,
    earliest: number,
  ): EventReadResult {
    const end = this.#events.length;
    const page: StoredEvent[] = [];
    let bytes = 0;
    let blockedAt: StoredEvent | null = null;
    let oldestScanned = end;

    for (let index = end - 1; index >= 0; index -= 1) {
      const event = this.#events[index]!;
      oldestScanned = index;
      if (!matches(event)) continue;
      if (page.length > 0 && bytes + event.bytes > this.#maxPageBytes) {
        blockedAt = event;
        break;
      }
      page.unshift(event);
      bytes += event.bytes;
      if (page.length >= limit) break;
    }

    const nextBefore =
      blockedAt !== null
        ? blockedAt.seq + 1
        : oldestScanned > 0
          ? this.#events[oldestScanned]!.seq
          : null;

    return {
      events: page.map((event) => toView(event, raw)),
      earliestRetainedSeq: earliest,
      lastSeq: this.#lastSeq,
      // The cursor to pass back as `since`: the largest seq the caller has now
      // seen. For a tail read that is the last seq in the log.
      nextSeq: this.#lastSeq,
      nextBefore,
      hasMore: false,
      truncated: earliest > 1,
    };
  }

  /** A forward page, `since` exclusive. Scan past non-matching events so cursors advance. */
  #readForward(
    since: number,
    limit: number,
    matches: (event: StoredEvent) => boolean,
    raw: boolean,
    earliest: number,
  ): EventReadResult {
    const start = this.#firstIndexAfter(since);
    const page: StoredEvent[] = [];
    let bytes = 0;
    let scanEnd = start;

    for (let index = start; index < this.#events.length; index += 1) {
      const event = this.#events[index]!;
      if (!matches(event)) {
        scanEnd = index + 1;
        continue;
      }
      if (page.length > 0 && bytes + event.bytes > this.#maxPageBytes) {
        // Leave the oversized event for the next page.
        scanEnd = index;
        break;
      }
      page.push(event);
      bytes += event.bytes;
      scanEnd = index + 1;
      if (page.length >= limit) break;
    }

    // `since` is exclusive, so the next cursor is the last scanned seq, not the
    // first unscanned one. `scanEnd` is the index after the last scanned event,
    // and a blocked event was deliberately left unscanned.
    const nextSeq =
      scanEnd > start ? this.#events[scanEnd - 1]!.seq : since;

    return {
      events: page.map((event) => toView(event, raw)),
      earliestRetainedSeq: earliest,
      lastSeq: this.#lastSeq,
      nextSeq,
      nextBefore:
        start === 0
          ? null
          : start < this.#events.length
            ? this.#events[start]!.seq
            : this.#lastSeq + 1,
      hasMore: scanEnd < this.#events.length,
      truncated: since + 1 < earliest,
    };
  }

  /** A backward page, `before` exclusive. Events are returned in ascending order. */
  #readBackward(
    before: number,
    limit: number,
    matches: (event: StoredEvent) => boolean,
    raw: boolean,
    earliest: number,
  ): EventReadResult {
    const end = this.#firstIndexAtOrAfter(before);
    const page: StoredEvent[] = [];
    let bytes = 0;
    let oldestScanned = end;
    let blockedAt: StoredEvent | null = null;

    for (let index = end - 1; index >= 0; index -= 1) {
      const event = this.#events[index]!;
      oldestScanned = index;
      if (!matches(event)) continue;
      if (page.length > 0 && bytes + event.bytes > this.#maxPageBytes) {
        blockedAt = event;
        break;
      }
      page.unshift(event);
      bytes += event.bytes;
      if (page.length >= limit) {
        return {
          events: page.map((entry) => toView(entry, raw)),
          earliestRetainedSeq: earliest,
          lastSeq: this.#lastSeq,
          nextSeq: this.#lastSeq,
          nextBefore: index > 0 ? this.#events[index]!.seq : null,
          hasMore: index > 0,
          truncated: index === 0 && earliest > 1,
        };
      }
    }

    const nextBefore =
      blockedAt !== null
        ? blockedAt.seq + 1
        : oldestScanned > 0
          ? this.#events[oldestScanned]!.seq
          : null;

    return {
      events: page.map((event) => toView(event, raw)),
      earliestRetainedSeq: earliest,
      lastSeq: this.#lastSeq,
      nextSeq: this.#lastSeq,
      nextBefore,
      hasMore: blockedAt !== null,
      truncated: oldestScanned === 0 && earliest > 1,
    };
  }

  #firstIndexAfter(seq: number): number {
    let low = 0;
    let high = this.#events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#events[mid]!.seq <= seq) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  #firstIndexAtOrAfter(seq: number): number {
    let low = 0;
    let high = this.#events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#events[mid]!.seq < seq) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  #trim(): void {
    while (
      this.#events.length > 1 &&
      (this.#events.length > this.#maxEvents || this.#bytes > this.#maxBytes)
    ) {
      const removed = this.#events.shift()!;
      this.#bytes -= removed.bytes;
    }
  }
}

function toView(event: StoredEvent, includeRaw: boolean): EventView {
  const data = includeRaw ? event.data : stripPrivateData(event.data);
  return { seq: event.seq, at: event.at, type: event.type, turn: event.turn, data };
}

/**
 * Filters are applied to the event as the caller would see it: when `raw` is
 * false, private ACP payloads are not searchable.
 */
function createMatcher(
  options: EventReadOptions,
): (event: StoredEvent) => boolean {
  const types =
    options.types && options.types.length > 0 ? new Set(options.types) : null;
  const turn = options.turn;
  const grep =
    options.grep !== undefined && options.grep.length > 0
      ? options.grep.toLowerCase()
      : null;
  if (types === null && turn === undefined && grep === null) return () => true;

  return (event) => {
    if (types !== null && !types.has(event.type)) return false;
    if (turn !== undefined && event.turn !== turn) return false;
    if (grep !== null) {
      const data = options.raw ? event.data : stripPrivateData(event.data);
      let haystack: string;
      try {
        haystack = `${event.type} ${JSON.stringify(data)}`.toLowerCase();
      } catch {
        haystack = event.type.toLowerCase();
      }
      if (!haystack.includes(grep)) return false;
    }
    return true;
  };
}

const PRIVATE_KEYS = ["raw", "rawInput", "rawOutput", "content"] as const;

/** Verbose ACP payloads are available only when the caller asks for raw data. */
function stripPrivateData(data: Record<string, unknown>): Record<string, unknown> {
  if (!PRIVATE_KEYS.some((key) => key in data)) return data;
  const copy = { ...data };
  for (const key of PRIVATE_KEYS) delete copy[key];
  return copy;
}

function serializedSize(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Bounds one event so a single huge tool result cannot evict the rest of the log.
 * The original payload is replaced by a flagged preview, never silently dropped.
 */
function boundData(
  data: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const shrunk = shrink(data, 0) as Record<string, unknown>;
  const size = serializedSize(shrunk);
  if (size <= maxBytes) return shrunk;

  const result: Record<string, unknown> = { ...shrunk, rawTruncated: true };
  const raw = result.raw;
  if (raw !== undefined) {
    result.raw = rawPreview(raw, Math.min(4_096, Math.max(256, Math.floor(maxBytes / 4))));
  }
  // Heavy ACP fields are replaced by markers before the whole event is discarded.
  for (const key of ["rawInput", "rawOutput", "content", "locations"]) {
    if (key in result) result[key] = { __truncated: true };
  }

  if (serializedSize(result) <= maxBytes) return result;

  return {
    __truncated: true,
    rawTruncated: true,
    bytes: size,
    note: `event payload exceeded ${maxBytes} bytes; original was discarded`,
  };
}

function rawPreview(raw: unknown, maxChars: number): Record<string, unknown> {
  let preview = "";
  try {
    preview = JSON.stringify(raw).slice(0, maxChars);
  } catch {
    preview = "[unserializable]";
  }
  return { __truncated: true, bytes: serializedSize(raw), preview };
}

/** Recursively bounds strings and arrays. Depth-bounded to avoid pathological input. */
function shrink(value: unknown, depth: number): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") {
    return value.length > 16_384 ? `${value.slice(0, 16_384)}… [truncated]` : value;
  }
  if (Array.isArray(value)) {
    const bounded = value.slice(0, 200).map((item) => shrink(item, depth + 1));
    if (value.length > 200) bounded.push(`[… ${value.length - 200} more]`);
    return bounded;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = shrink(entry, depth + 1);
    }
    return result;
  }
  return value;
}
