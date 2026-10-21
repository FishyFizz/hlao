import type { StreamingConnection } from "../../client.js";
import { connectStreaming } from "../../client.js";
import { HlaoError } from "../../errors.js";
import { isTerminalStatus } from "../../protocol.js";
import type {
  EventView,
  ListResult,
  NotificationFrame,
  SessionView,
  SubscribeResult,
} from "../../protocol.js";
import {
  booleanOption,
  expectPositionals,
  parseArgs,
  stringOption,
  usageError,
} from "../args.js";
import {
  COMMON,
  contextFrom,
  out,
  writeJsonLine,
} from "../context.js";
import { helpRequested } from "../help.js";
import { labelOf, resolveInList } from "./session-view.js";
import { parseEventTypes, parseGrepFilter } from "../event-filters.js";
import {
  chunkIds,
  eventSummary,
  formatClock,
  safeJson,
  sleep,
  truncate,
  typeLabel,
} from "./watch-format.js";

const LABEL_CHARS = 20;

/**
 * A caller-owned merged timeline. The supervisor owns no watch loop and no
 * index: this command holds one fleet subscription (chunked to the wire's
 * 100-id limit), follows each session's cursor, and interleaves the events it
 * receives. New sessions are attached by resubscribing with their cursor.
 */
export async function cmdWatch(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "all", type: "boolean" },
    { name: "root", type: "string", valueName: "SESSION" },
    { name: "type", type: "string", valueName: "TYPE", multiple: true },
    { name: "grep", type: "string", valueName: "TEXT" },
    { name: "regex", type: "boolean" },
    { name: "verbose", type: "boolean" },
  ]);
  if (helpRequested(parsed, "watch")) return 0;
  expectPositionals(parsed, "watch", 0, 0);

  const rawTypes = parseEventTypes(parsed);
  const types = rawTypes.length > 0 ? new Set(rawTypes) : null;
  const { grep, regex: regexFlag } = parseGrepFilter(parsed);
  let regex: RegExp | null = null;
  if (regexFlag && grep !== undefined) {
    try {
      regex = new RegExp(grep, "i");
    } catch (error) {
      throw usageError(`--grep is not a valid regular expression: ${(error as Error).message}`);
    }
  }
  const literal = grep !== undefined && regex === null ? grep.toLowerCase() : null;
  const verbose = booleanOption(parsed, "verbose") === true;
  const includeAll = booleanOption(parsed, "all") === true;
  const rootToken = stringOption(parsed, "root");
  const ctx = contextFrom(parsed);

  let stopping = false;
  let stopCurrent: (() => void) | null = null;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    stopCurrent?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    // Cursors and labels survive a reconnect; the target set is refreshed from
    // the supervisor on each connection so a restarted instance is re-read.
    // A resolved --root is pinned: the supervisor does not persist sessions
    // across a restart, so re-resolving the token later would either fail
    // forever or silently retarget the watch at a different root.
    const cursors = new Map<string, number>();
    const labels = new Map<string, string>();
    let targets = new Set<string>();
    let rootId: string | undefined;
    let firstConnection = true;

    for (;;) {
      if (stopping) break;
      let rootResolutionFailed = false;
      let reconnectReported = false;
      let conn: StreamingConnection;
      try {
        conn = await connectStreaming({
          home: ctx.home,
          cliPath: ctx.cliPath,
          callerSessionId: ctx.callerSessionId,
        });
      } catch (error) {
        if (stopping) break;
        if (
          error instanceof HlaoError &&
          (error.code === "version_mismatch" || error.code === "bad_request")
        ) {
          throw error;
        }
        process.stderr.write(
          `hlao: cannot watch — ${(error as Error).message}; retrying\n`,
        );
        await sleep(1_000);
        continue;
      }

      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      conn.onClose(() => resolveClosed());
      stopCurrent = () => {
        conn.close();
        resolveClosed();
      };

      try {
        const list = await conn.request<ListResult>("sessions.list", {
          includeClosed: true,
        });
        if (rootToken !== undefined && rootId === undefined) {
          try {
            rootId = resolveInList(list.sessions, rootToken).rootId;
          } catch (error) {
            rootResolutionFailed = true;
            throw error;
          }
        }
        const selected = list.sessions.filter(
          (session) =>
            (includeAll || !isTerminalStatus(session.status)) &&
            (rootId === undefined || session.rootId === rootId),
        );
        targets = new Set(selected.map((session) => session.id));
        for (const session of list.sessions) labels.set(session.id, labelOf(session));
        for (const session of selected) {
          // On the first connection, live-only means "from now". After a
          // reconnect, a session we did not know about may have emitted events
          // during the gap, so start at 0 and let its short history replay.
          if (!cursors.has(session.id)) {
            cursors.set(session.id, firstConnection ? session.lastSeq : 0);
          }
        }
        firstConnection = false;
        for (const id of [...cursors.keys()]) {
          if (!list.sessions.some((session) => session.id === id)) cursors.delete(id);
        }

        let subscriptionIds: number[] = [];
        let resubscribing = false;
        let resubscribeQueued = false;

        const pickCursors = (ids: string[]): Record<string, number> =>
          Object.fromEntries(ids.map((id) => [id, cursors.get(id) ?? 0]));

        const subscribe = async (): Promise<void> => {
          // Drop the old subscriptions first. The gap loses nothing: the new
          // subscription starts from the cursors, and unsubscribing first means
          // a failure cannot leave an unknown subscription behind.
          const previous = subscriptionIds;
          subscriptionIds = [];
          for (const id of previous) {
            await conn
              .request("stream.unsubscribe", { subscription: id })
              .catch(() => {
                // The connection may already be gone.
              });
          }

          const ids = [...targets];
          const chunks = chunkIds(ids);
          const nextIds: number[] = [];
          if (chunks.length === 0) {
            const result = await conn.request<SubscribeResult>("stream.subscribe", {
              fleet: true,
            });
            nextIds.push(result.subscription);
            absorbViews(result.sessions);
            reportTruncated(result.truncated);
          } else {
            for (let index = 0; index < chunks.length; index += 1) {
              const group = chunks[index]!;
              const result = await conn.request<SubscribeResult>("stream.subscribe", {
                sessionIds: group,
                ...(index === 0 ? { fleet: true } : {}),
                since: pickCursors(group),
              });
              nextIds.push(result.subscription);
              absorbViews(result.sessions);
              reportTruncated(result.truncated);
            }
          }
          subscriptionIds = nextIds;
        };

        const resubscribe = (): void => {
          if (resubscribing) {
            resubscribeQueued = true;
            return;
          }
          resubscribing = true;
          void (async () => {
            try {
              do {
                resubscribeQueued = false;
                await subscribe();
              } while (resubscribeQueued && !stopping);
            } catch (error) {
              if (!stopping) {
                process.stderr.write(
                  `hlao: resubscribe failed — ${(error as Error).message}; reconnecting\n`,
                );
                reconnectReported = true;
                resolveClosed();
              }
            } finally {
              resubscribing = false;
            }
          })();
        };

        const absorbViews = (sessions: SessionView[]): void => {
          for (const session of sessions) {
            labels.set(session.id, labelOf(session));
            if (!inScope(session)) continue;
            if (!targets.has(session.id)) {
              targets.add(session.id);
              // A session discovered mid-stream may already have events that
              // the fleet-only subscription could not deliver. Start at 0 so
              // its first prompt and turn are not lost; the cursor dedupe keeps
              // that bounded.
              cursors.set(session.id, 0);
              emitJoined(session.id);
              resubscribe();
            } else if (!cursors.has(session.id)) {
              cursors.set(session.id, 0);
            }
          }
        };

        const reportTruncated = (ids: string[]): void => {
          for (const id of ids) {
            process.stderr.write(
              `hlao: history for ${id} was evicted before the watch cursor\n`,
            );
          }
        };

        const onNotification = (frame: NotificationFrame): void => {
          if (frame.kind === "session") {
            const session = frame.session;
            labels.set(session.id, labelOf(session));
            if (inScope(session) && !targets.has(session.id)) {
              targets.add(session.id);
              // See absorbViews: replay from 0 so the first events survive.
              cursors.set(session.id, 0);
              emitJoined(session.id);
              resubscribe();
            }
            return;
          }
          if (frame.kind === "session.removed") {
            if (targets.delete(frame.sessionId)) {
              if (!ctx.json) out(ctx.style.dim(`− ${frame.sessionId} left`));
              else writeJsonLine({ kind: "session.removed", sessionId: frame.sessionId });
            }
            return;
          }
          let cursor = cursors.get(frame.sessionId) ?? 0;
          for (const event of frame.events) {
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            if (!matches(event)) continue;
            emitEvent(frame.sessionId, event);
          }
          cursors.set(frame.sessionId, Math.max(cursor, frame.cursor));
        };

        const inScope = (session: SessionView): boolean =>
          (includeAll || !isTerminalStatus(session.status)) &&
          (rootId === undefined || session.rootId === rootId);

        const matches = (event: EventView): boolean => {
          if (types !== null && !types.has(event.type)) return false;
          if (regex !== null || literal !== null) {
            let haystack: string;
            try {
              haystack = `${event.type} ${JSON.stringify(event.data)}`;
            } catch {
              haystack = event.type;
            }
            if (regex !== null && !regex.test(haystack)) return false;
            if (literal !== null && !haystack.toLowerCase().includes(literal)) {
              return false;
            }
          }
          return true;
        };

        const emitJoined = (sessionId: string): void => {
          if (ctx.json) {
            writeJsonLine({ kind: "session.joined", sessionId });
          } else {
            out(ctx.style.dim(`+ ${sessionId} joined`));
          }
        };

        const emitEvent = (sessionId: string, event: EventView): void => {
          if (ctx.json) {
            writeJsonLine({ kind: "event", sessionId, event });
            return;
          }
          const label = truncate(labels.get(sessionId) ?? sessionId, LABEL_CHARS);
          const summary = eventSummary(event);
          const payload =
            verbose && event.data !== undefined
              ? `  ${ctx.style.dim(truncate(safeJson(event.data), 200))}`
              : "";
          out(
            `${formatClock(event.at)}  ${ctx.style.dim(label.padEnd(LABEL_CHARS))}  ${typeLabel(
              event.type,
              ctx.style,
            )}  ${summary}${payload}`,
          );
        };

        conn.onNotification(onNotification);
        // Hold the resubscribe lock across the first subscription: a session
        // discovered in its fleet views must queue, not race the chunk loop.
        resubscribing = true;
        try {
          await subscribe();
        } finally {
          resubscribing = false;
        }
        if (resubscribeQueued) {
          resubscribeQueued = false;
          resubscribe();
        }
        if (ctx.json) {
          writeJsonLine({ kind: "watch.started", sessions: targets.size });
        } else {
          out(
            ctx.style.dim(
              `hlao watch · ${targets.size} session${targets.size === 1 ? "" : "s"} · Ctrl-C to stop`,
            ),
          );
        }

        await closed;
      } catch (error) {
        // A bad --root is a selector error, not a transient one: the session
        // table is gone after a supervisor restart, so retrying only repeats
        // the same line forever. Mirror the other commands and exit.
        if (rootResolutionFailed) throw error;
        if (!stopping) {
          process.stderr.write(
            `hlao: watch failed — ${(error as Error).message}; reconnecting\n`,
          );
          reconnectReported = true;
        }
      } finally {
        stopCurrent = null;
        conn.close();
      }

      if (stopping) break;
      if (!reconnectReported) {
        process.stderr.write("hlao: watch connection closed; reconnecting\n");
      }
      await sleep(1_000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}
