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

export interface QueueItemView {
  position: number | null;       // null = active turn
  textPreview: string;           // <= 200 chars, whitespace collapsed
  textLength: number;
  from: string;                  // sender session id or "operator"
  queuedMs: number;
  turn: number | null;
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
  createdBy: string;             // "operator" or the requesting session id; provenance only
  requestedMode?: string;        // mode requested at spawn; recorded in session.created
  env: Record<string, string>;   // includes the HLAO_* identity variables, including HLAO_NAME
  permissionPolicy: "ask" | "allow" | "deny";
  home: string;                  // injected as HLAO_HOME
  config: SessionConfig;         // timeouts, retention
  cliPath: string;               // injected as HLAO_CLI
  skill: boolean;                // prepend the skill pointer to the first prompt
  skillPath: string;             // injected as HLAO_SKILL; home copy of skills/hlao/SKILL.md
  skillVersion: string;          // injected as HLAO_SKILL_VERSION
  resumeSessionId?: string;      // reopen with ACP session/load instead of session/new
  forkSessionId?: string;        // copy with ACP session/fork
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
   * `from` is recorded on prompt events. Every prompt gets a message id; an optional
   * idempotency key dedupes retries for one hour (256 keys) without enqueuing again.
   */
  send(text: string, wait: boolean, timeoutMs: number, from?: string,
       options?: { messageId?: string; idempotencyKey?: string }): Promise<SendResult>;

  /** Cursor-addressed or tail read. Pure: does not consume the log. A tail read reports
   *  `truncated` when any earlier event was evicted; `raw: false` strips private payloads. */
  read(options: ReadOptions): ReadResult;

  /** Set or clear the operator label. Appends session.renamed; identity is unchanged. */
  setName(name: string | null): void;

  /** One-shot await. Resolves at the first condition, timeout, or session end. */
  waitFor(until: WaitUntil, since: number | undefined, timeoutMs: number,
          signal?: AbortSignal): Promise<WaitResult>;

  /** ACP session/cancel plus discard of queued prompts. keepQueue leaves the backlog. */
  cancel(keepQueue?: boolean, by?: string): Promise<{ discarded: number }>;

  /** Protocol close when supported, then terminate; idempotent. */
  close(force?: boolean, by?: string): Promise<{ killed: boolean; wasTerminal: boolean }>;

  /** Answer the pending permission request. Throws no_pending_permission / bad_option.
   *  `always` also switches the session policy to allow and prefers allow_always. */
  permit(optionId?: string, requestId?: string, always?: boolean, by?: string): {
    requestId: string;
    optionId: string;
  };

  /** Read or switch the live HLAO permission policy. */
  setPolicy(policy: "ask" | "allow" | "deny", by?: string): void;

  /** Read or switch the provider's native mode. Throws bad_request when the
   *  backend advertises no modes, bad_option for an unknown mode. */
  setMode(modeId: string, by?: string): Promise<SessionModes>;

  /** Set a provider config option; values are validated against the advertised list. */
  setConfigOption(configId: string, value: string | boolean, by?: string):
    Promise<SessionConfigOptionView[]>;

  /** Set the option whose category is "model". */
  setModel(model: string, by?: string): Promise<SessionConfigOptionView[]>;

  /** Snapshot of the queue: the active item plus 1-based queued items. */
  queueView(): { active: QueueItemView | null; queue: QueueItemView[] };

  /** Remove one queued prompt by position or message id, settling it as cancelled. */
  dropQueued(target: { position: number } | { messageId: string }, by?: string):
    { dropped: QueueItemView; discarded: number };

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
4. **Cancellation is not a kill.** `cancel()` asks ACP to stop; `close(force)` kills. On
   POSIX the adapter is spawned detached and its whole process group is signaled, so tools it
   started do not outlive it; on Windows the existing `taskkill /T` path is unchanged.
5. **Permission requests are data.** An unanswered request appears in `view()` and produces
   `permission.requested`; it blocks only that session's turn. A provider can also ask
   outside a prompt turn (an autonomous cycle); such a request is surfaced and answered the
   same way, and its events carry `turn: null` and `data.outsideTurn: true`. The policy is
   `allow` by default, `ask` opt-in, and `permit(..., always)` can switch a live session to
   `allow`. A provider question (ACP elicitation) is separate state:
   `pendingElicitation`, `elicitation.requested`/`elicitation.resolved`, and
   `hlao elicit`. The permission policy never answers it, because a form answer
   cannot be inferred from `allow` or `deny`.
6. **Provider modes and config options are data.** `view().modes` and `view().configOptions`
   report what the adapter advertises; setters change them and record the actor.
7. **Names are labels.** `setName` changes `name` and emits an event; the handle, addressing,
   and the environment already injected into the running adapter (`HLAO_NAME`) are unchanged.
8. **Events are monotonic.** `append` assigns the next sequence before waiters run.
9. **Reads never mutate.** A read does not acknowledge or consume anything.
10. **Timeouts are bounds, not schedules.** Nothing in this module starts a recurring timer.
11. **Cancel is explicit about the queue.** The default discards the backlog; `keepQueue`
    stops only the active turn. Every discard is attributed and previewed.
12. **No addressing policy.** This module has no visibility or scope logic; the supervisor
    resolves any session in the instance. `parentId` is lineage, not authority.
13. **The skill is a pointer, not a payload.** When enabled, the first prompt prepends a short
    text block naming the skill path; the prompt carries no file contents. `HLAO_SKILL` and
    `HLAO_SKILL_VERSION` describe the same file to the adapter's environment.
14. **Resume replays the provider, it does not copy it.** With `resumeSessionId`, startup
    calls ACP `session/load` on that id instead of `session/new`. The provider's replay
    notifications arrive before the request resolves, so the session id filter is installed
    first; every event appended during the call is marked `replay: true`, and
    `session.resumed` records the seq range. A backend without the `loadSession` capability
    is refused with `spawn_failed`; the session never starts empty under a resumed id. The
    event log is still a bounded projection: a transcript larger than retention evicts its
    own earliest replay events, and says so.
15. **Fork copies; it does not mutate.** With `forkSessionId`, startup calls ACP
    `session/fork` and adopts the provider-assigned id. The source session is untouched.
    When `loadSession` is also available, the new session is loaded immediately so the copied
    history is replayed and marked like a resume; otherwise `session.forked` reports
    `historyLoaded: false`. Fork and resume cannot be combined.

## Dependencies the session expects

- An `EventLog` with bounded retention (`events` module).
- A backend manifest whose `command` and `args` launch an ACP v1 adapter on stdio.
- No network, no database, no filesystem writes (except the supervisor's diagnostic log).

## Errors

`spawn` rejects with `spawn_failed`, `backend_unavailable`, or `internal`. Post-spawn
failures surface as `failed` session state and failed prompt completions; they do not reject
`send` because `send` is queued work, not a synchronous call.
