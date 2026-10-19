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
| `not_found` | no session matching the id/prefix in scope |
| `ambiguous_id` | prefix matches more than one session in scope (`details.candidates`) |
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

All session ids accept an exact handle or an unambiguous prefix.

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
  configError?: string        // present when user config failed validation
}
```

### `agents.list`

Params: `{ cwd?: string }` — project backends under `<cwd>/.hlao/agents.json` are merged in.

Result: `{ agents: AgentView[] }`

```ts
type AgentView = {
  name: string;
  source: "builtin" | "user" | "project";
  command: string;
  args: string[];
  envKeys: string[];             // values are never returned
  description?: string;
  available: boolean;
  unavailableReason?: string;
};
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

### `sessions.send`

Params:

```ts
{ sessionId: string; text: string; wait?: boolean; timeoutMs?: number }
```

`timeoutMs` defaults to `config.sendWaitTimeoutMs`; `0` means no timeout.

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
with `hasMore: true`; a single event larger than the budget is returned alone.

Result:

```ts
{
  session: SessionView;
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;               // cursor for the following read
  hasMore: boolean;
  truncated: boolean;            // events in [since+1, earliestRetainedSeq-1] were evicted
}
```

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

Params: `{ sessionId: string }`. Result: `{ session: SessionView; discarded: number }`.

Requests an ACP `session/cancel`, resolves any pending permission as `cancelled`, and
settles queued prompts as `cancelled` (`discarded` counts them). It does not kill the
process.

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
  | "session.created" | "session.initialized" | "session.closed" | "session.failed"
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
