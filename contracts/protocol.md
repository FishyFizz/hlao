# Contract — `protocol`

The wire between the supervisor and any client. The bundled CLI is the reference client; a
TUI, web dashboard, or MCP server is another client and must not need private access. Core owns
session state, addressing, and these methods. It owns no presentation.

An HLAO instance — one `HLAO_HOME`, supervisor, socket, and token — is one address space and
one swarm boundary. Every session in it is addressable by every client. Isolation is another
instance; there is no cross-instance visibility.

```
human  -> dashboard / TUI  --\
                              >-- socket protocol -> core (supervisor)
agent  -> CLI / MCP        --/
```

## Transport

The wire is defined over application **frames**, not over a socket implementation.
`contracts/stream.md` is the transport contract: one JSON object per frame, ordered, reliable,
bidirectional, boundary-preserving, and bounded. On byte-stream transports the encoding is
NDJSON. A transport adapter maps that contract onto a channel; swapping the channel does not
change this protocol.

- Protocol 2.0: one request per connection, one response, then the connection closes.
- Endpoint: named pipe on Windows (`\\.\pipe\hlao-<hash of HLAO_HOME>`), Unix domain socket
  at `<HLAO_HOME>/supervisor.sock` elsewhere.
- Authentication: every request carries the token from `<HLAO_HOME>/supervisor.json`. Any
  local process holding that token is an operator; the token is the authority. The token is
  local-IPC authority, not a network or browser credential (ADR 0009).
- Maximum request frame: 16 MiB. Longer frames are rejected with `bad_request`.

## Client model

- Call `hello` first. It reports the protocol version, capabilities, and supervisor health.
- Poll `sessions.list` for a fleet view and `sessions.read` with `nextSeq`/`nextBefore` for a
  session's log. There is no push subscription in protocol 2.x. A live client should poll at a
  cadence it chooses; the supervisor owns no recurring timer.
- Use `sessions.wait` when a client would otherwise poll a blocking condition. It is one-shot:
  it resolves once and must be re-armed.
- All timestamps are ISO-8601 strings. Durations such as "pending for" are computed by the
  client.
- A client that wants a composite operation (`cancel` then wait, broadcast to a subtree, bulk
  permit) loops over these methods. Such compositions are client assemblies, not protocol
  concepts.

## Envelope

```ts
type RequestEnvelope = {
  id: number;                    // client-chosen, echoed in the response
  method: string;                // one of the methods below
  params?: unknown;              // method-specific, validated at the boundary
  token: string;                 // from supervisor.json
  callerSessionId?: string | null; // from HLAO_SESSION_ID; attribution and self-defaulting
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

`callerSessionId` is **attribution, not permission**. It records who acted (`by`) and supplies
self-defaulting; it is not a security boundary and it does not filter what the caller can see.
The token is the instance boundary.

## Error codes

| Code | Meaning |
|---|---|
| `bad_request` | malformed envelope or invalid params |
| `unauthorized` | wrong or missing token |
| `version_mismatch` | client and supervisor protocol versions differ |
| `not_found` | no session matching the id, name, or prefix in this instance |
| `ambiguous_id` | a name or prefix matches more than one session (`details.candidates`) |
| `forbidden` | reserved; core session methods do not emit it after protocol 2.0 |
| `operator_only` | method is reserved for an operator shell (no `callerSessionId`) |
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

## Versioning

`protocolVersion` is `{ major, minor }`.

- **Major** changes only when a client written for the previous major can no longer work.
  A client must require major equality. `hello` with a different major returns
  `version_mismatch` with `details.client` and `details.supervisor`.
- **Minor** grows with additive methods, fields, and event types. A newer supervisor is
  compatible with an older client; a newer client must use capabilities or version checks
  before relying on an addition.
- `capabilities` lists additive features this supervisor implements. Unknown capabilities must
  be ignored. Known values: `backends.list`, `session.usage`, `read.filters`, `read.before`,
  `wait.multi`.
- Adding an optional request field, a result field, a method, or an event type is a minor
  change. Changing or removing existing semantics is a major change.
- **2.0** removes the `scope` field and makes every session in an instance addressable by every
  caller. There is no per-session visibility filter. Isolation is a separate instance.

## Methods

All `sessionId` params accept an exact handle first, then a unique session name, then a unique
handle prefix, resolved within **this HLAO instance**. Duplicate names are `ambiguous_id` with
`details.candidates`; the full handle still resolves.

Every session in the instance is addressable by every caller. `callerSessionId` is recorded as
attribution but does not restrict addressing. `parentId`/`rootId`/`depth` are lineage, not
authority. The only isolation boundary is another instance (`HLAO_HOME`, socket, and token).

### `hello`

Params:

```ts
{
  protocolVersion?: { major: number; minor: number }; // the client's version
}
```

Result:

```ts
{
  protocolVersion: { major: number, minor: number },
  capabilities: string[],
  pid: number,
  startedAt: string,
  version: string,
  sessions: number,
  configHash: string,         // sha256 of the user config file, or "missing"
  configError?: string        // present when user config failed validation
}
```

If `protocolVersion` is present and its major differs, the response is `version_mismatch`.
The field was added in 1.1; a client that may meet a 1.0 supervisor should call `hello` with
`{}` first, then use the returned version and capabilities. The pre-1.1 numeric form
(`protocolVersion: 1`) is accepted for a supervisor that has not restarted; new clients should
send the object form.

### `backends.list`

Params: `{ cwd?: string }`.

Result: `{ backends: AgentView[] }`.

The same merged view (builtin, user, project) as the bundled `hlao agents` command, sorted by
name. `cwd` must be absolute; when omitted it defaults to the caller session's cwd, or the
supervisor's cwd for an operator. A session caller defaults to its own cwd. This
exists so a dashboard or MCP client does not reimplement config merging or read config files.

```ts
type AgentView = {
  name: string;
  source: "builtin" | "user" | "project";
  command: string;
  args: string[];
  envKeys: string[];          // names only, never values
  description?: string;
  configPath?: string;
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
  model?: string;                // value for the option whose category is "model"
  config?: Record<string, string | boolean>; // session config options applied before the prompt
  parentSessionId?: string;      // lineage; defaults to the caller's live session, else a root
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

Result: `{ sessions: SessionView[] }`

Every session in this instance, sorted by creation time. There is no per-caller scope. A client
may filter or sort the flat list locally.

### `sessions.get`

Params: `{ sessionId: string }`. Result: `{ session: SessionView }`.

### `sessions.rename`

Params: `{ sessionId: string; name: string | null }` (`null` clears the name).

Result: `{ session: SessionView }`. Appends a `session.renamed` event with
`{ name, by: "operator" }`. Names are mutable labels, not identity: they do not affect
addressing, the handle, or `HLAO_SESSION_ID`. Duplicate names are instance-wide and resolve as
`ambiguous_id`; the full handle always resolves.

### `sessions.forget`

Params: `{ sessionId: string }`. Result: `{ sessionId: string; forgotten: true }`.

Removes a **terminal** session from the live table immediately instead of waiting for
`retainClosedMs`. A live session is `bad_request`; a terminal session with retained descendants
is also `bad_request`, so lineage never dangles. Any caller in the instance may forget a
terminal session. Forgetting discards the retained event
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
  since?: number;                // forward: seq > since
  before?: number;               // backward: seq < before; exclusive with since
  limit?: number;                // default 100, maximum 1000
  raw?: boolean;                 // include original ACP update payloads in the result
  types?: EventType[];           // keep only these event types
  turn?: number;                 // keep only this turn
  grep?: string;                 // case-insensitive literal over type + data JSON
}
```

Filters are ANDed and applied while scanning, before the page limit and byte budget. A cursor
always advances past scanned events, not only returned events, so a filtered follower does not
rescan the same non-matching range. `grep` searches the event as returned: private payloads
require `raw: true`.

A page is also bounded by a byte budget (8 MiB). Fewer than `limit` events may be returned,
with `hasMore: true`; a single event larger than the budget is returned alone. Without
`raw: true`, the private payload keys `raw`, `rawInput`, `rawOutput`, and `content` are
removed from each event's `data`; orchestration fields remain.

Result:

```ts
{
  session: SessionView;
  events: EventView[];            // ascending seq in both directions
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;                // forward cursor: pass as since
  nextBefore: number | null;      // backward cursor: pass as before; null = no older page
  hasMore: boolean;               // more events in the scan direction
  truncated: boolean;             // history before the page was evicted
}
```

For a tail read (no cursor), `nextSeq` is `lastSeq + 1` and `hasMore` is false; use
`nextBefore` to page backward. For a `since` read, `truncated` is true when
`since + 1 < earliestRetainedSeq`. For a `before` read, it is true when the scan reached the
oldest retained event and earlier history was evicted.

### `sessions.wait`

Params:

```ts
{
  sessionId?: string;            // exactly one of sessionId or sessionIds
  sessionIds?: string[];         // 1..100; no duplicate ids
  mode?: "any" | "all";          // default "any"; ignored for one id
  until: "idle" | "permission" | "exit" | "change";
  since?: number;                // only for "change" with a single id
  timeoutMs?: number;            // defaults to config.waitTimeoutMs; 0 = no timeout
}
```

Result:

```ts
{
  satisfied: boolean;            // aggregate
  reason: "idle" | "permission" | "exit" | "change" | "timeout";
  waitedMs: number;
  results: {
    session: SessionView;
    satisfied: boolean;
    reason: "idle" | "permission" | "exit" | "change" | "timeout" | "pending";
  }[];
  session?: SessionView;         // present only for a single-id request
}
```

The wait is one-shot: it resolves at the first matching condition and never re-arms. A
timeout never changes a session.

With several ids, `any` resolves on the first target that satisfies and `all` when every target
does. A target that ends before satisfying `idle`, `permission`, or `change` is unsatisfied
with reason `exit`; for `all`, that resolves the whole wait immediately. A target that is not
settled when the aggregate resolves is evaluated at that moment: it is reported as satisfied
if it already meets the condition, otherwise as `pending`. `change` uses each target's `lastSeq`
at call time as its baseline; `since` is rejected with more than one id. All ids are resolved
in this instance before waiting; one unknown or ambiguous id fails the request.

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
  usage: {
    used: number;
    size: number;
    cost: { amount: number; currency: string } | null; // amount in minor units
    at: string;                                       // usage event timestamp
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
