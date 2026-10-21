import { isTerminalStatus } from "../protocol.js";
import type {
  WaitParams,
  WaitResult,
  WaitTargetResult,
} from "../protocol.js";
import type { Session } from "../session.js";
import { evaluateWait } from "../session/waits.js";

/** The orchestration facts a wait condition needs from a session view. */
function targetState(session: Session) {
  const view = session.view();
  return {
    view,
    state: {
      status: view.status,
      queued: view.queued,
      awaitingInput:
        view.pendingPermissions.length > 0 || view.pendingElicitation !== null,
      terminal: isTerminalStatus(view.status),
    },
  };
}

/**
 * Await one or more sessions. A single target delegates to its own wait,
 * which avoids a second timer and preserves the session's filtered-change
 * cursor. Several targets fan out over the same condition.
 */
export async function awaitWaitTargets(
  params: WaitParams,
  signal: AbortSignal,
  targets: readonly Session[],
  defaultTimeoutMs: number,
): Promise<WaitResult> {
  const timeoutMs = params.timeoutMs ?? defaultTimeoutMs;

  if (targets.length === 1) {
    const session = targets[0]!;
    const waited = await session.waitFor(
      params.until,
      params.since,
      timeoutMs,
      signal,
      params.types,
      params.grep,
    );
    const view = session.view();
    return {
      ...waited,
      results: [{ session: view, satisfied: waited.satisfied, reason: waited.reason }],
      session: view,
    };
  }

  const mode = params.mode ?? "any";
  const baselines = targets.map((target) => target.view().lastSeq);
  const startedAt = Date.now();

  return await new Promise<WaitResult>((resolve) => {
    const controller = new AbortController();
    const onRequestAbort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onRequestAbort, { once: true });

    const settled = new Map<number, WaitTargetResult>();
    let finished = false;

    const snapshot = (index: number): WaitTargetResult => {
      const target = targets[index]!;
      const { view, state } = targetState(target);
      if (params.until === "change") {
        const page = target.read({
          since: baselines[index] ?? 0,
          limit: 1,
          raw: false,
          types: params.types,
          grep: params.grep,
        });
        return page.events.length > 0
          ? { session: view, satisfied: true, reason: "change" }
          : {
              session: view,
              satisfied: false,
              reason: state.terminal ? "exit" : "pending",
            };
      }
      const observation = evaluateWait(params.until, state);
      return {
        session: view,
        satisfied: observation.satisfied,
        reason: observation.reason,
      };
    };

    const finish = (satisfied: boolean, reason: WaitResult["reason"]): void => {
      if (finished) return;
      finished = true;
      controller.abort();
      signal.removeEventListener("abort", onRequestAbort);
      const results = targets.map((_target, index) => {
        return settled.get(index) ?? snapshot(index);
      });
      resolve({
        satisfied,
        reason,
        waitedMs: Date.now() - startedAt,
        results,
      });
    };

    const settleAll = (): void => {
      const reasons = [...settled.values()].map((entry) => entry.reason);
      const reason = reasons.every((entry) => entry === "exit") ? "exit" : "timeout";
      finish(false, reason);
    };

    targets.forEach((target, index) => {
      const since = params.until === "change" ? baselines[index] : params.since;
      void target
        .waitFor(
          params.until,
          since,
          timeoutMs,
          controller.signal,
          params.types,
          params.grep,
        )
        .then(
          (waited) => {
            settled.set(index, {
              session: target.view(),
              satisfied: waited.satisfied,
              reason: waited.reason,
            });
            if (mode === "all" && !waited.satisfied) {
              finish(false, waited.reason);
              return;
            }
            if (mode === "any" && waited.satisfied) {
              finish(true, waited.reason);
              return;
            }
            if (settled.size === targets.length) {
              if (mode === "all") {
                const reasons = [...settled.values()].map(
                  (entry) => entry.reason,
                );
                // If any target ended, report that as the aggregate reason:
                // an ended session is the fact a caller must not miss, even
                // when another target reached the condition.
                finish(
                  true,
                  reasons.includes("exit") ? "exit" : params.until,
                );
              } else {
                settleAll();
              }
            }
          },
          () => {
            settled.set(index, {
              session: target.view(),
              satisfied: false,
              reason: "timeout",
            });
            if (settled.size === targets.length) {
              if (mode === "all") finish(false, "timeout");
              else settleAll();
            }
          },
        );
    });
  });
}
