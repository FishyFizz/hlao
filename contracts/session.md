# Contract — `session`

One `Session` wraps exactly one adapter process and one ACP session. It is the only module
that speaks ACP. Everything it exposes is orchestration state and typed events; ACP payloads
cross the boundary only inside `EventView.data.raw` when `read({ raw: true })` is requested.

```ts
export type SessionStatus =
  | "starting" | "idle" | "busy" | "waiting_permission" | "closed" | "failed";

export interface SessionModes {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
}

export type WaitUntil = "idle" | "permission" | "exit" | "change";

export interface PromptCompletion {
  ok: boolean;
  turn: number | null;
  stopReason?: StopReason;       // ACP stop reason
  text: string;                  // accumulated agent_message text for this turn
  cancelledBeforeStart?: boolean;
  error?: { code: string; message: string };
}

export interface SendResult {
  queued: boolean;
  turn: number | null;
  completed: boolean;
  timedOut: boolean;
  stopReason?: StopReason;
  text?: string;
}

export interface ReadOptions {
  since?: number;
  limit?: number;                // 1..1000, default 100
  raw?: boolean;
}

export interface ReadResult {
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;
  hasMore: boolean;
  truncated: boolean;
}

export interface WaitResult {
  satisfied: boolean;
  reason: WaitUntil | "timeout";
  waitedMs: number;
}

export interface SpawnOptions {
  id: string;                    // generated before the process starts
  backend: BackendManifest;
  cwd: string;
  parentId: string | null;
  rootId: string;
  depth: number;
  name: string | null;
  env: Record<string, string>;   // includes the HLAO_* identity variables
  permissionPolicy: "ask" | "allow" | "deny";
  home: string;                  // injected as HLAO_HOME
  config: SessionConfig;         // timeouts, retention
  cliPath: string;               // injected as HLAO_CLI
  log: (line: string) => void;   // supervisor diagnostics only
}

export interface SessionConfig {
  startupTimeoutMs: number;
  maxEventsPerSession: number;
  maxEventLogBytes: number;
  maxEventBytes: number;
}

export class Session {
  static async spawn(options: SpawnOptions): Promise<Session>;

  readonly id: string;

  /**
   * Queue a prompt; one turn at a time.
   * Throws session_closed / session_not_ready for a terminal or unready session.
   * Once queued, every prompt settles exactly once; a running session does not reject.
   */
  send(text: string, wait: boolean, timeoutMs: number): Promise<SendResult>;

  /** Cursor-addressed or tail read. Pure: does not consume the log. */
  read(options: ReadOptions): ReadResult;

  /** One-shot await. Resolves at the first condition, timeout, or session end. */
  waitFor(until: WaitUntil, since: number | undefined, timeoutMs: number,
          signal?: AbortSignal): Promise<WaitResult>;

  /** ACP session/cancel plus discard of queued prompts. */
  cancel(): Promise<{ discarded: number }>;

  /** Protocol close when supported, then terminate; idempotent. */
  close(force?: boolean): Promise<{ killed: boolean; wasTerminal: boolean }>;

  /** Answer the pending permission request. Throws no_pending_permission / bad_option.
   *  `always` also switches the session policy to allow and prefers allow_always. */
  permit(optionId?: string, requestId?: string, always?: boolean): {
    requestId: string;
    optionId: string;
  };

  /** Read or switch the provider's native mode. Throws bad_request when the
   *  backend advertises no modes, bad_option for an unknown mode. */
  setMode(modeId: string): Promise<SessionModes>;

  /** Snapshot; never exposes mutable internals. */
  view(): SessionView;

  /** Terminal state: closed or failed. */
  readonly isTerminal: boolean;
}
```

## Invariants

1. **One turn at a time.** `send` enqueues; the queue is drained serially.
2. **The queue is visible.** `view().queued` and `prompt.queued` events describe it.
3. **No prompt is lost silently.** Every prompt settles exactly once: completed, cancelled,
   failed, or cancelled-before-start.
4. **Cancellation is not a kill.** `cancel()` asks ACP to stop; `close(force)` kills.
5. **Permission requests are data.** An unanswered request appears in `view()` and produces
   `permission.requested`; it blocks only that session's turn. The policy is `allow` by
   default, `ask` opt-in, and `permit(..., always)` can switch a live session to `allow`.
6. **Provider modes are data.** `view().modes` reports the adapter's current and available
   modes; `setMode` changes one when the adapter advertises them.
6. **Events are monotonic.** `append` assigns the next sequence before waiters run.
7. **Reads never mutate.** A read does not acknowledge or consume anything.
8. **Timeouts are bounds, not schedules.** Nothing in this module starts a recurring timer.

## Dependencies the session expects

- An `EventLog` with bounded retention (`events` module).
- A backend manifest whose `command` and `args` launch an ACP v1 adapter on stdio.
- No network, no database, no filesystem writes (except the supervisor's diagnostic log).

## Errors

`spawn` rejects with `spawn_failed`, `backend_unavailable`, or `internal`. Post-spawn
failures surface as `failed` session state and failed prompt completions; they do not reject
`send` because `send` is queued work, not a synchronous call.
