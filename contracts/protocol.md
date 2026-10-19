# Contract — `protocol`

The wire between the CLI and the supervisor. Both sides are HLAO code; there is no third
party. Nothing outside this file is part of the protocol.

## Transport

- One request per connection, one response, then the connection closes.
- Frames are a single JSON object followed by `\n`.
- Endpoint: named pipe on Windows (`\\.\pipe\hlao-<hash of HLAO_HOME>`), Unix domain socket
  at `<HLAO_HOME>/supervisor.sock` elsewhere.
- Authentication: every request carries the token from `<HLAO_HOME>/supervisor.json`.
- Maximum request frame: 16 MiB. Longer frames are rejected with `bad_request`.

## Envelope

```ts
type RequestEnvelope = {
  id: number;                    // client-chosen, echoed in the response
  method: string;                // one of the methods below
  params?: unknown;              // method-specific, validated at the boundary
  token: string;                 // from supervisor.json
  callerSessionId?: string | null; // from HLAO_SESSION_ID; absent for the operator
};

type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: WireError };

type WireError = {
  code: ErrorCode;
  message: string;
  details?: unknown;
};
```

`callerSessionId` is a coordination claim, not an authenticated identity. It scopes what the
caller can see; it is not a security boundary.

## Error codes

| Code | Meaning |
|---|---|
| `bad_request` | malformed envelope or invalid params |
| `unauthorized` | wrong or missing token |
| `version_mismatch` | CLI and supervisor protocol versions differ |
| `not_found` | no session matching the id, name, or prefix in scope |
| `ambiguous_id` | a name or prefix matches more than one session in scope (`details.candidates`) |
| `forbidden` | target session is outside the caller's scope |
| `operator_only` | method is reserved for an unscoped operator shell |
| `backend_not_found` | no such backend manifest |
| `backend_unavailable` | manifest resolved but its command is missing |
| `spawn_failed` | the adapter failed to start or complete the ACP handshake |
| `session_closed` | session is closed or failed |
| `session_not_ready` | session exists but has no ACP session yet |
| `no_pending_permission` | `sessions.permit` with nothing pending |
| `bad_option` | permission option id not offered by the request |
| `config_invalid` | user or project config is invalid; the message names the file |
| `session_failed` | a prompt turn failed for a reason the adapter reported |
| `timeout` | a supervisor-side bounded operation expired (connections, shutdown) |
| `supervisor_unavailable` | client-side: the supervisor could not be reached or started |
| `internal` | an unexpected supervisor error; message is safe to display |

## Methods

All `sessionId` params accept an exact handle first, then a unique session name, then a unique
handle prefix, resolved within the caller's scope. Duplicate names are `ambiguous_id` with
`details.candidates`; the full handle still resolves.

`sessions.send` has one deliberate scope exception: a caller may target its **direct parent**
by exact id, exact name, or a prefix that uniquely identifies the parent. No other method may
reach an ancestor; reads, waits, cancel, close, permit, policy, mode, option, and rename remain
`forbidden` there.

Scope is enforced against the caller's live session when one is named. If `callerSessionId` is
absent, the request is an operator request and sees every session.

### `hello`

Params: `{}`.

Result:

```ts
{
  protocolVersion: 1,
  pid: number,
  startedAt: string,
  version: string,
  sessions: number,
  configHash: string,         // sha256 of the user config file, or "missing"
  configError?: string        // present when user config failed validation
}
```

### `sessions.spawn`

Params:

```ts
{
  backend: string;
  cwd?: string;                  // absolute; defaults to the supervisor's cwd
  name?: string;                 // operator label, not an identity
  prompt?: string;               // optional first message
  wait?: boolean;                // wait for the first turn when prompt is present
  timeoutMs?: number;            // bound on that wait; defaults to sendWaitTimeoutMs
  mode?: string;                 // provider mode to select before returning (sessions.set_mode)
  model?: string;                // value for the option whose category is "model"
  config?: Record<string, string | boolean>; // session config options applied before the prompt
  parentSessionId?: string;      // defaults to callerSessionId
  permissionPolicy?: "ask" | "allow" | "deny"; // defaults to config
  env?: Record<string, string>;  // extra environment for the adapter
}
```

Result:

```ts
{
  session: SessionView;
  nextSeq: number;               // pass as --since to read from the beginning
  firstTurn?: { stopReason: StopReason; text: string; timedOut: boolean };
}
```

The call resolves once `initialize` and `session/new` both succeed. If `prompt` is present
and `wait` is true, it also waits for the first turn (bounded by `sendWaitTimeoutMs`). A
timeout is reported as `firstTurn.timedOut = true`, not as an error.

### `sessions.list`

Params: `{ includeClosed?: boolean; cwd?: string }`.

Result: `{ scope: "operator" | "session", sessions: SessionView[] }`

Operator scope lists all sessions. Session scope lists the caller and its descendants.

### `sessions.get`

Params: `{ sessionId: string }`. Result: `{ session: SessionView }`.

### `sessions.rename`

Params: `{ sessionId: string; name: string | null }` (`null` clears the name).

Result: `{ session: SessionView }`. Appends a `session.renamed` event with
`{ name, by: "operator" }`. Names are mutable labels, not identity: they do not affect scope,
the handle, or `HLAO_SESSION_ID`.

### `sessions.forget`

Params: `{ sessionId: string }`. Result: `{ sessionId: string; forgotten: true }`.

Removes a **terminal** session from the live table immediately instead of waiting for
`retainClosedMs`. A live session is `bad_request`; a terminal session with retained descendants
is also `bad_request`, so lineage never dangles. The action is in scope: an operator may forget
anything, a session may forget itself or a descendant. Forgetting discards the retained event
log for that session.

### `sessions.send`

Params:

```ts
{ sessionId: string; text: string; wait?: boolean; timeoutMs?: number }
```

`timeoutMs` defaults to `config.sendWaitTimeoutMs`; `0` means no timeout. The caller's session
id (or `"operator"`) is recorded as `prompt.sent.from` / `prompt.queued.from`.

Result:

```ts
{
  session: SessionView;
  queued: boolean;               // true when the session was busy
  turn: number | null;           // null when not yet dispatched
  completed: boolean;
  timedOut: boolean;
  stopReason?: StopReason;
  text?: string;                 // accumulated agent text for that turn
}
```

`timedOut: true` means the turn is still running; the caller should `read --since` later.
`completed: false, timedOut: false` is only possible when `wait` is false.

### `sessions.read`

Params:

```ts
{
  sessionId: string;
  since?: number;                // absent = tail
  limit?: number;                // default 100, maximum 1000
  raw?: boolean;                 // include original ACP update payloads in the result
}
```

A page is also bounded by a byte budget (8 MiB). Fewer than `limit` events may be returned,
with `hasMore: true`; a single event larger than the budget is returned alone. Without
`raw: true`, the private payload keys `raw`, `rawInput`, `rawOutput`, and `content` are
removed from each event's `data`; orchestration fields remain.

Result:

```ts
{
  session: SessionView;
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;               // cursor for the following read
  hasMore: boolean;
  truncated: boolean;            // history before the page was evicted
}
```

For a tail read, `truncated` is true whenever any event before the returned page was evicted
(`earliestRetainedSeq > 1`), not only when the page itself starts late. For a `since` read,
it is true when `since + 1 < earliestRetainedSeq`.

### `sessions.wait`

Params:

```ts
{
  sessionId: string;
  until: "idle" | "permission" | "exit" | "change";
  since?: number;                // only for "change"; defaults to lastSeq at call time
  timeoutMs?: number;            // defaults to config.waitTimeoutMs; 0 = no timeout
}
```

Result:

```ts
{
  satisfied: boolean;
  reason: "idle" | "permission" | "exit" | "change" | "timeout";
  waitedMs: number;
  session: SessionView;
}
```

The wait is one-shot: it resolves at the first matching condition and never re-arms. A
timeout never changes the session.

### `sessions.cancel`

Params: `{ sessionId: string; keepQueue?: boolean }`.
Result: `{ session: SessionView; discarded: number }`.

Requests an ACP `session/cancel`, resolves any pending permission as `cancelled`, and settles
queued prompts as `cancelled` (`discarded` counts them). With `keepQueue: true`, the queue is
kept and the next message runs after the active turn settles. It does not kill the process.

### `sessions.close`

Params: `{ sessionId: string; force?: boolean }`.

Result: `{ session: SessionView; killed: boolean; wasTerminal: boolean }`.

Attempts ACP `session/close` when the adapter advertises it, then terminates the process.
`force: true` skips the protocol close. `wasTerminal` reports whether the session was
already closed or failed before this call, so a caller can avoid claiming a change it did
not make. Closed sessions remain readable for `config.retainClosedMs`.

### `sessions.permit`

Params: `{ sessionId: string; optionId?: string; requestId?: string; always?: boolean }`.

Result: `{ session: SessionView; requestId: string; optionId: string; by: "operator" }`.

With no `optionId`, the first `allow_once`/`allow_always` option is chosen; with `always`,
`allow_always` is preferred. With no `requestId`, the single pending request is used.
`always: true` also sets the session's `permissionPolicy` to `allow` and appends a
`policy.changed` event. Errors: `no_pending_permission`, `bad_option`.

### `sessions.set_mode`

Params: `{ sessionId: string; modeId: string }`. Result: `{ session: SessionView }`.

Switches the provider's native session mode when the adapter advertises modes. The session
view reports `modes: { currentModeId, availableModes }`. Errors: `bad_request` when the
backend advertises no modes, `bad_option` when the mode is not in the advertised list, and
`session_closed` for a terminal session.

### `sessions.set_policy`

Params: `{ sessionId: string; permissionPolicy: "ask" | "allow" | "deny" }`.
Result: `{ session: SessionView }`.

Changes the live HLAO permission policy without requiring a pending request. Emits
`policy.changed` with the acting caller. It does not alter provider-native modes or config
options.

### `sessions.set_config_option`

Params: `{ sessionId: string; configId: string; value: string | boolean }`.
Result: `{ session: SessionView }`.

Sends ACP `session/set_config_option` and replaces the session's `configOptions` from the
response. Boolean options accept a boolean or the strings `"true"`/`"false"`. A select option
requires one of the advertised value ids. Errors: `bad_request` when the option is not
advertised or the type is wrong, `bad_option` when the value is not offered,
`session_not_ready` before ACP is ready, `session_closed` for a terminal session.

### `sessions.queue`

Params: `{ sessionId: string }`.
Result: `{ session: SessionView; active: QueueItemView | null; queue: QueueItemView[] }`.

```ts
type QueueItemView = {
  position: number | null;       // 1-based queue order; null for the active turn
  textPreview: string;           // at most 200 characters, whitespace collapsed
  textLength: number;            // full original length
  from: string;                  // sender session id or "operator"
  queuedMs: number;
  turn: number | null;
};
```

### `sessions.queue_drop`

Params: `{ sessionId: string; position: number }` (1..1000).
Result: `{ session: SessionView; dropped: QueueItemView; discarded: number }`.

Removes one queued prompt. The prompt is settled as cancelled before it runs and emits
`prompt.discarded` with `reason: "dropped"`, `position`, and the actor. Out-of-range positions
are `bad_request` and do not change the queue.

### `supervisor.reload`

Params: `{}`. Operator only.

Result: `{ configHash: string; configError: string | null }`.

Re-reads the user config file. Only future spawns are affected; live sessions keep the config
they were created with. The result's `configHash` is the fingerprint of the file that was read.
When loading fails, the supervisor falls back to defaults, records `configError`, and rejects
`sessions.spawn` with `config_invalid` until a valid config is reloaded. `hello.configHash`
always reports the last successfully read (or attempted) file.

### `supervisor.shutdown`

Params: `{ force?: boolean }`. Operator only.

Result: `{ sessionsClosed: number }`. The supervisor replies, then exits. `force` skips
graceful ACP closes.

## Event view

```ts
type EventView = {
  seq: number;                   // 1-based, strictly increasing per session
  at: string;                    // ISO-8601
  type: EventType;
  turn: number | null;
  data: Record<string, unknown>; // raw:true adds data.raw = original ACP update
};

type EventType =
  | "session.created" | "session.initialized" | "session.renamed"
  | "session.closed" | "session.failed"
  | "prompt.sent" | "prompt.queued" | "prompt.discarded"
  | "turn.started" | "turn.ended" | "cancel.requested"
  | "agent.message" | "agent.thought" | "user.message"
  | "tool.call" | "tool.update" | "plan" | "plan.update"
  | "permission.requested" | "permission.resolved" | "policy.changed"
  | "notice" | "usage" | "mode" | "config" | "commands" | "session.info"
  | "compaction" | "subagent" | "stderr" | "error" | "raw";
```

Event ordering per session is total and monotonic. An event is appended before any waiter
that depends on it is notified.

Actor fields are explicit:

- `prompt.sent` and `prompt.queued` carry `from`: a session id or `"operator"`.
- `prompt.discarded` carries the original `from`, the acting `by`, `reason`, and a bounded
  `textPreview`.
- `permission.resolved`, `policy.changed`, `mode`, `config`, `cancel.requested`,
  `session.renamed`, and `session.closed` carry `by`: the caller session id, `"operator"`,
  `"policy:<name>"` for an automatic answer, or `"agent"` when the adapter itself changed a
  mode/config option.
- `permission.resolved` with `optionId: null` also carries `reason` (for example `"cancel"`,
  `"close"`, `"turn-ended"`).

## Session view

```ts
type SessionView = {
  id: string;                    // 6-char handle
  name: string | null;
  backend: string;
  cwd: string;
  status: "starting" | "idle" | "busy" | "waiting_permission" | "closed" | "failed";
  parentId: string | null;
  rootId: string;
  depth: number;
  createdAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  turn: number;
  turnStartedAt: string | null;  // set while busy or waiting_permission
  queued: number;
  lastSeq: number;
  pendingPermission: PermissionView | null;
  lastStopReason: StopReason | null;
  agentSessionId: string | null; // exposed for diagnostics only
  processId: number | null;
  exit: { code: number | null; signal: string | null } | null;
  permissionPolicy: "ask" | "allow" | "deny";
  modes: {
    currentModeId: string;
    availableModes: { id: string; name: string; description?: string }[];
  } | null;
  configOptions: {
    id: string;
    name: string;
    description?: string;
    category?: string;
    type: "select" | "boolean";
    currentValue: string | boolean;
    values: { value: string; name: string; description?: string; group?: string }[];
  }[] | null;
};

type PermissionView = {
  requestId: string;
  toolCallId: string | null;
  title: string;
  kind: string | null;
  options: { optionId: string; name: string; kind: string }[];
  requestedAt: string;
};
```
