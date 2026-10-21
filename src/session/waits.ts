import type {
  EventType,
  EventView,
  SessionStatus,
  WaitUntil,
} from "../protocol.js";
import type { WaitResult } from "./types.js";

/** The orchestration facts every wait condition is derived from. */
export interface WaitState {
  status: SessionStatus;
  queued: number;
  awaitingInput: boolean;
  terminal: boolean;
}

export interface WaitObservation {
  satisfied: boolean;
  /** `pending` means the condition does not hold yet and the session is alive. */
  reason: Exclude<WaitUntil, "change"> | "pending";
}

/**
 * Evaluate one non-change wait condition. This is the single definition shared
 * by a session's own wait, the supervisor's already-satisfied check, and the
 * per-target snapshot of a multi-session wait.
 */
export function evaluateWait(
  until: Exclude<WaitUntil, "change">,
  state: WaitState,
): WaitObservation {
  switch (until) {
    case "idle":
      if (state.status === "idle") return { satisfied: true, reason: "idle" };
      return {
        satisfied: false,
        reason: state.terminal ? "exit" : "pending",
      };
    case "settled":
      if (state.terminal) return { satisfied: true, reason: "exit" };
      if (state.awaitingInput) return { satisfied: true, reason: "permission" };
      if (state.status === "idle" && state.queued === 0) {
        return { satisfied: true, reason: "idle" };
      }
      return { satisfied: false, reason: "pending" };
    case "permission":
      if (state.awaitingInput) return { satisfied: true, reason: "permission" };
      return {
        satisfied: false,
        reason: state.terminal ? "exit" : "pending",
      };
    case "exit":
      return state.terminal
        ? { satisfied: true, reason: "exit" }
        : { satisfied: false, reason: "pending" };
  }
}

export interface WaitHost {
  state(): WaitState;
  /** The log's last seq when the wait starts; the default change cursor. */
  lastSeq: number;
  readChange(
    since: number,
    types?: EventType[],
    grep?: string,
  ): { events: EventView[]; nextSeq: number };
  /** Register a check and return its remover. */
  addWaiter(check: () => void): () => void;
}

/**
 * A one-shot await. Nothing re-arms: the timeout is a bound on the await, not
 * a schedule, and a filtered change cursor advances past scanned non-matches.
 */
export function waitForSession(
  host: WaitHost,
  until: WaitUntil,
  since: number | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  types?: EventType[],
  grep?: string,
): Promise<WaitResult> {
  const startedAt = Date.now();
  let changeCursor = until === "change" ? (since ?? host.lastSeq) : (since ?? 0);

  return new Promise<WaitResult>((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let removeWaiter: (() => void) | null = null;

    const finish = (satisfied: boolean, reason: WaitUntil | "timeout"): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      removeWaiter?.();
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ satisfied, reason, waitedMs: Date.now() - startedAt });
    };

    const check = (): void => {
      if (until === "change") {
        const page = host.readChange(changeCursor, types, grep);
        if (page.events.length > 0) {
          finish(true, "change");
          return;
        }
        // Advance past scanned non-matching events; the corrected cursor is the
        // last scanned seq, so a filtered waiter does not rescan.
        changeCursor = page.nextSeq;
        if (host.state().terminal) finish(false, "exit");
        return;
      }
      const observation = evaluateWait(until, host.state());
      if (observation.satisfied) {
        finish(true, observation.reason as WaitUntil);
      } else if (observation.reason === "exit") {
        finish(false, "exit");
      }
    };

    const onAbort = (): void => finish(false, "timeout");

    if (signal?.aborted) {
      finish(false, "timeout");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    removeWaiter = host.addWaiter(check);
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
      timer.unref?.();
    }
    check();
  });
}
