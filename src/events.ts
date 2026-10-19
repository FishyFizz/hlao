import { nowIso } from "./time.js";
import type { EventType, EventView } from "./protocol.js";

export interface EventInput {
  type: EventType;
  turn?: number | null;
  data?: Record<string, unknown>;
}

export interface EventReadOptions {
  since?: number;
  limit: number;
  raw: boolean;
}

export interface EventReadResult {
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;
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
    const since = options.since;
    const earliest = this.earliestRetainedSeq;
    let page: StoredEvent[];
    let truncated = false;
    let hasMore = false;
    let nextSeq: number;

    if (since === undefined) {
      const end = this.#events.length;
      let start = end;
      let bytes = 0;
      while (start > 0 && end - start < limit) {
        const candidate = this.#events[start - 1]!;
        if (end - start > 0 && bytes + candidate.bytes > this.#maxPageBytes) break;
        bytes += candidate.bytes;
        start -= 1;
      }
      page = this.#events.slice(start, end);
      nextSeq = this.#lastSeq + 1;
      hasMore = false;
      // A tail window is still incomplete history if events were evicted before it.
      truncated = earliest > 1;
    } else {
      truncated = since + 1 < earliest;
      let start = this.#firstIndexAfter(since);
      let end = start;
      let bytes = 0;
      while (end < this.#events.length && end - start < limit) {
        const candidate = this.#events[end]!;
        if (end > start && bytes + candidate.bytes > this.#maxPageBytes) break;
        bytes += candidate.bytes;
        end += 1;
      }
      page = this.#events.slice(start, end);
      const lastInPage = page[page.length - 1];
      nextSeq = lastInPage ? lastInPage.seq + 1 : Math.max(since, this.#lastSeq + 1);
      hasMore = lastInPage !== undefined && lastInPage.seq < this.#lastSeq;
    }

    return {
      events: page.map((event) => toView(event, options.raw)),
      earliestRetainedSeq: earliest,
      lastSeq: this.#lastSeq,
      nextSeq,
      hasMore,
      truncated,
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
