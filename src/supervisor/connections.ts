import { HlaoError } from "../errors.js";
import type {
  NotificationFrame,
  RequestEnvelope,
  ResponseEnvelope,
  SessionView,
  SubscribeParams,
  SubscribeResult,
  UnsubscribeParams,
  UnsubscribeResult,
} from "../protocol.js";
import { parseEnvelope, parseParams } from "../protocol.js";
import type { Session } from "../session.js";
import {
  FrameTooLargeError,
  type WireStream,
} from "../stream.js";
import { failure } from "./util.js";

/** A persistent connection may have this many requests in flight. */
const MAX_INFLIGHT_REQUESTS = 64;
/** Events delivered per session per notification flush. */
const MAX_NOTIFICATION_EVENTS = 200;
/** Close a consumer that lets this much data sit in the transport buffer. */
const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
/** Subscriptions one persistent connection may hold. */
const MAX_SUBSCRIPTIONS = 64;
/** How long a connection may stay silent before its first frame. */
const FIRST_FRAME_TIMEOUT_MS = 15_000;

export interface SubscriptionScope {
  /** Report views for every session in the instance, including new ones. */
  all: boolean;
  /** Stream events for these sessions (and report their views). */
  sessionIds: ReadonlySet<string>;
}

/** The connection-side half of dispatch; passed to the supervisor per request. */
export interface ConnectionHandle {
  readonly persistent: boolean;
  subscribe(params: SubscribeParams): SubscribeResult;
  unsubscribe(params: UnsubscribeParams): UnsubscribeResult;
}

export interface ConnectionHost {
  /** Dispatch one validated envelope for this connection. */
  handle(
    envelope: RequestEnvelope,
    signal: AbortSignal,
    connection: ConnectionHandle,
  ): Promise<unknown>;
  /** Resolve caller-supplied session tokens, rejecting unknown ones. */
  resolveSessionIds(ids: readonly string[]): string[];
  /** Sessions in a subscription's view scope, in table order. */
  subscriptionSessions(scope: SubscriptionScope): Session[];
  /** Called after a response is written (shutdown-after-response hook). */
  afterResponse(): void;
}

interface SubscriptionState extends SubscriptionScope {
  id: number;
  /** Last delivered event seq per session; pass as `since` to read. */
  cursors: Map<string, number>;
  /** Last view sent per session, serialized for change detection. */
  lastViews: Map<string, string>;
}

/**
 * The persistent-stream transport: framing ownership, the request/response
 * envelope for each connection, subscriptions, and the one change-driven
 * flush. It owns no orchestration state; it reads the live table through the
 * host and sends what the protocol says it may.
 */
export class ConnectionHub {
  readonly #host: ConnectionHost;
  readonly #streams = new Set<WireStream>();
  readonly #connections = new Set<ConnectionState>();
  #closed = false;

  constructor(host: ConnectionHost) {
    this.#host = host;
  }

  accept(stream: WireStream): void {
    if (this.#closed) {
      stream.terminate();
      return;
    }
    this.#streams.add(stream);
    const state = new ConnectionState(stream, this.#host, (closed) => {
      this.#connections.delete(closed);
      this.#streams.delete(stream);
    });
    if (!state.closed) this.#connections.add(state);
  }

  /** Called after a session state change or a table change. No timer. */
  notifyChange(): void {
    for (const connection of this.#connections) {
      connection.scheduleFlush();
    }
  }

  /** Terminate every live stream and forget its subscriptions. */
  close(): void {
    this.#closed = true;
    for (const stream of this.#streams) stream.terminate();
    this.#streams.clear();
    this.#connections.clear();
  }
}

class ConnectionState implements ConnectionHandle {
  readonly stream: WireStream;
  persistent = false;
  readonly subscriptions = new Map<number, SubscriptionState>();
  nextSubscription = 1;
  inflight = 0;
  flushScheduled = false;
  closed = false;
  /** The first frame decides the connection mode; later frames wait for it. */
  handshaking = true;
  readonly early: string[] = [];

  readonly #host: ConnectionHost;
  readonly #abort = new AbortController();
  readonly #onClosed: (state: ConnectionState) => void;

  constructor(
    stream: WireStream,
    host: ConnectionHost,
    onClosed: (state: ConnectionState) => void,
  ) {
    this.stream = stream;
    this.#host = host;
    this.#onClosed = onClosed;

    stream.onClose(() => {
      this.#abort.abort();
      this.closed = true;
      this.#onClosed(this);
      this.subscriptions.clear();
    });

    let first = true;
    const initialTimer = setTimeout(() => {
      if (first && !this.closed) stream.terminate();
    }, FIRST_FRAME_TIMEOUT_MS);
    initialTimer.unref?.();

    stream.onError((error) => {
      if (this.closed) return;
      if (first) {
        first = false;
        clearTimeout(initialTimer);
        if (error instanceof FrameTooLargeError) {
          this.#write(failure(0, new HlaoError("bad_request", "request frame too large")));
          stream.close();
          return;
        }
      }
      this.#abort.abort();
      this.closed = true;
      stream.terminate();
    });

    stream.onFrame((line) => {
      if (this.closed) return;
      if (first) {
        first = false;
        clearTimeout(initialTimer);
        void this.#handleFrame(line).then(() => {
          this.handshaking = false;
          for (const queued of this.early.splice(0)) {
            if (this.closed) break;
            void this.#handleFrame(queued);
          }
        });
        return;
      }
      if (this.handshaking) {
        if (this.early.length >= MAX_INFLIGHT_REQUESTS) {
          this.closed = true;
          stream.terminate();
          return;
        }
        this.early.push(line);
        return;
      }
      void this.#handleFrame(line);
    });
  }

  subscribe(params: SubscribeParams): SubscribeResult {
    if (!this.persistent) {
      throw new HlaoError(
        "bad_request",
        "stream.subscribe requires a persistent stream (hello with stream.persistent)",
      );
    }
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new HlaoError(
        "too_many_requests",
        `at most ${MAX_SUBSCRIPTIONS} subscriptions may be active`,
      );
    }

    const sessionIds = this.#host.resolveSessionIds(params.sessionIds ?? []);
    const subscription: SubscriptionState = {
      id: this.nextSubscription,
      all: params.fleet === true,
      sessionIds: new Set(sessionIds),
      cursors: new Map(),
      lastViews: new Map(),
    };
    this.nextSubscription += 1;

    const sessions: SessionView[] = [];
    const cursors: Record<string, number> = {};
    const truncated: string[] = [];

    for (const session of this.#host.subscriptionSessions(subscription)) {
      const view = session.view();
      sessions.push(view);
      const since = params.since?.[session.id];
      const cursor = since ?? view.lastSeq;
      subscription.cursors.set(session.id, cursor);
      subscription.lastViews.set(session.id, JSON.stringify(view));
      cursors[session.id] = cursor;
      if (since !== undefined && session.read({ since, limit: 1 }).truncated) {
        truncated.push(session.id);
      }
    }

    this.subscriptions.set(subscription.id, subscription);

    return {
      subscription: subscription.id,
      sessions,
      cursors,
      truncated,
    };
  }

  unsubscribe(params: UnsubscribeParams): UnsubscribeResult {
    if (!this.persistent) {
      throw new HlaoError(
        "bad_request",
        "stream.unsubscribe requires a persistent stream",
      );
    }
    if (!this.subscriptions.delete(params.subscription)) {
      throw new HlaoError(
        "not_found",
        `no subscription ${params.subscription} on this connection`,
      );
    }
    return { subscription: params.subscription, removed: true };
  }

  scheduleFlush(): void {
    if (!this.persistent || this.closed || this.flushScheduled) return;
    if (this.subscriptions.size === 0) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.#flush();
    });
  }

  async #handleFrame(line: string): Promise<void> {
    let id = 0;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new HlaoError("bad_request", "request is not valid JSON");
      }
      const envelope = parseEnvelope(parsed);
      id = envelope.id;
      if (this.inflight >= MAX_INFLIGHT_REQUESTS) {
        throw new HlaoError(
          "too_many_requests",
          `at most ${MAX_INFLIGHT_REQUESTS} requests may be in flight`,
        );
      }
      this.inflight += 1;
      try {
        const result = await this.#host.handle(
          envelope,
          this.#abort.signal,
          this,
        );
        this.#write({ id, ok: true, result });
        if (!this.persistent && requestsPersistentStream(envelope)) {
          this.persistent = true;
        }
      } finally {
        this.inflight -= 1;
      }
    } catch (error) {
      this.#write(failure(id, error));
    }

    this.scheduleFlush();

    // A legacy connection carries exactly one request, as in protocol 2.0.
    if (!this.persistent) {
      this.closed = true;
      this.stream.close();
    }

    this.#host.afterResponse();
  }

  #flush(): void {
    if (!this.persistent || this.closed) return;
    if (this.stream.bufferedBytes() > MAX_STREAM_BUFFER_BYTES) {
      // The consumer is behind. Close it; it can resume from its cursor.
      this.closed = true;
      this.stream.terminate();
      return;
    }

    let more = false;

    for (const subscription of this.subscriptions.values()) {
      const seen = new Set<string>();

      for (const session of this.#host.subscriptionSessions(subscription)) {
        const id = session.id;
        seen.add(id);
        const view = session.view();
        const serialized = JSON.stringify(view);
        if (subscription.lastViews.get(id) !== serialized) {
          subscription.lastViews.set(id, serialized);
          this.#write({
            type: "notification",
            subscription: subscription.id,
            kind: "session",
            session: view,
          });
        }

        if (!subscription.sessionIds.has(id)) continue;
        const cursor = subscription.cursors.get(id) ?? view.lastSeq;
        if (view.lastSeq <= cursor) continue;

        let since = cursor;
        let truncated = false;
        let pages = 0;
        while (pages < 4) {
          const page = session.read({
            since,
            limit: MAX_NOTIFICATION_EVENTS,
          });
          pages += 1;
          truncated = truncated || page.truncated;
          const last = page.events[page.events.length - 1];
          if (last === undefined) break;
          since = last.seq;
          subscription.cursors.set(id, last.seq);
          this.#write({
            type: "notification",
            subscription: subscription.id,
            kind: "event",
            sessionId: id,
            events: page.events,
            cursor: last.seq,
            truncated,
          });
          if (!page.hasMore) break;
        }
        if (pages >= 4) more = true;
      }

      for (const id of [...subscription.lastViews.keys()]) {
        if (seen.has(id)) continue;
        subscription.lastViews.delete(id);
        subscription.cursors.delete(id);
        this.#write({
          type: "notification",
          subscription: subscription.id,
          kind: "session.removed",
          sessionId: id,
        });
      }
    }

    if (more) this.scheduleFlush();
  }

  #write(frame: ResponseEnvelope | NotificationFrame): void {
    try {
      this.stream.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // The client may have vanished.
    }
  }
}

function requestsPersistentStream(envelope: RequestEnvelope): boolean {
  if (envelope.method !== "hello") return false;
  try {
    return parseParams("hello", envelope.params).stream?.persistent === true;
  } catch {
    return false;
  }
}
