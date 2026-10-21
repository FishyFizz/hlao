# Contract — `protocol`

The wire between the supervisor and any client. The bundled CLI is the reference client; a
TUI, web dashboard, or MCP server is another client and must not need private access. This
contract covers the whole interface: the transport that carries frames, the envelope that
gives a frame meaning, the methods, and the projections they return. Core owns session state,
addressing, and these methods. It owns no presentation.

An HLAO instance — one `HLAO_HOME`, supervisor, socket, and token — is one address space and
one swarm boundary. Every session in it is addressable by every client. Isolation is another
instance; there is no cross-instance visibility.

```
human  -> dashboard / TUI  --\
                              >-- socket protocol -> core (supervisor)
agent  -> CLI / MCP        --/
```

The interface is layered. Method semantics do not depend on the transport, and a transport
adapter does not interpret frames:

```
methods (hello, sessions.*, ...)         semantics
        │
   RequestEnvelope / Response            frames
        │
      WireStream                         transport seam
        │
  pipe / unix socket / TCP / ...         adapters
```

## Contents

- [Layers and terms](#layers-and-terms)
- [Transport](#transport) — frames, encodings, lifecycle, adapter interface, policy
- [Envelope](#envelope)
- [Error codes](#error-codes)
- [Versioning](#versioning)
- [Client model](#client-model)
- [Addressing](#addressing)
- [Methods](#methods)
- [Notifications](#notifications)
- [Event view](#event-view)
- [Session view](#session-view)

## Layers and terms

- A **frame** is one JSON object that satisfies the request or response envelope, or a server
  notification. A stream carries frames; it does not interpret them.
- A **stream** is an ordered, reliable, bidirectional, boundary-preserving channel of frames.
  `src/stream.ts` is the transport seam.
- A **connection** is one stream and its lifecycle: either one-shot or persistent.
- An **instance** is one `HLAO_HOME`, supervisor, endpoint, and token. The token is the only
  authority boundary.

## Transport

The wire is defined over application **frames**, not over a socket implementation. One JSON
object per frame, ordered, reliable, bidirectional, boundary-preserving, and bounded. A
transport adapter maps this contract onto a channel; swapping the channel does not change this
protocol.

### The frame

A **frame** is one JSON object that satisfies the request or response envelope. A stream
carries frames; it does not interpret them.

Required properties:

- **Ordered.** Frames arrive in the order they were written.
- **Reliable.** No loss, duplication, or reordering while the stream is open.
- **Bidirectional.** Both ends may write.
- **Boundary-preserving.** Each write is delivered as exactly one frame.
- **Bounded.** One frame may not exceed `MAX_FRAME_BYTES` (16 MiB) on the supervisor's inbound
  direction. A peer that exceeds it is violating the contract.

Encodings per adapter:

| Adapter | Encoding |
|---|---|
| Named pipe, Unix domain socket, TCP | NDJSON: one frame per `\n`-terminated line. A frame may span reads; one read may hold several frames. |
| WebSocket (planned) | One frame per WebSocket message; no delimiter is added. |
| SSE + POST (composed, planned) | SSE `data:` carries server frames; POST carries client frames. Two channels, correlated by the envelope `id`. |

A client must not depend on a transport's message boundaries. The canonical framing for
byte-stream transports is NDJSON; a message-oriented adapter delivers the same JSON text.
Empty lines are not frames.

### Endpoint and authentication

- Endpoint: named pipe on Windows (`\\.\pipe\hlao-<hash of HLAO_HOME>`), Unix domain socket
  at `<HLAO_HOME>/supervisor.sock` elsewhere.
- Authentication: every request carries the token from `<HLAO_HOME>/supervisor.json`. Any
  local process holding that token is an operator; the token is the authority. The token is
  local-IPC authority, not a network or browser credential (ADR 0009).
- Maximum request frame: 16 MiB. Longer frames are rejected with `bad_request`.

### Lifecycle

#### One-shot (default, protocol 2.0)

A connection that does not negotiate persistence carries exactly one request, one response,
then closes:

1. The client connects.
2. The client writes one request frame.
3. The supervisor writes one response frame.
4. The supervisor closes the stream.

The supervisor ignores frames after the first on such a connection and closes after replying.
A stream that sends no frame within 15 s is closed. This is what the bundled CLI uses.

#### Persistent (protocol 2.1)

`hello` with `stream: { persistent: true }` keeps the connection open and multiplexes requests
by `id`:

1. The client connects and writes `hello` with `stream: { persistent: true }`.
2. The supervisor validates the token and version and replies. On success the connection
   stays open; on failure the reply is an error and the connection closes.
3. Every later frame is a request. Requests carry the client-chosen `id`; several may be in
   flight, and responses may arrive out of order. At most 64 may be in flight
   (`too_many_requests`).
4. `stream.subscribe` registers interest. The supervisor emits notification frames (a server
   frame with `type: "notification"`) at the same append point that wakes a waiter.
   `stream.unsubscribe` removes one subscription.
5. Either side may close. A reconnect supplies per-session cursors so the server replays from
   `seq > cursor` and reports `truncated` when history was evicted.

Every request frame still carries the token. Persistence does not weaken per-frame
authentication. The first frame gates the connection: frames that arrive before the hello
reply are queued and then processed, so a client may pipeline safely.

None of this changes `wait`: it remains one-shot. Push and wait are two ways to observe the
same append point, not two authorities. The supervisor owns no timer in either mode.

### Adapter interface

`src/stream.ts` exports the seam. Other clients may implement the same shape:

```ts
type StreamTarget =
  | { kind: "path"; path: string }        // named pipe or Unix socket
  | { kind: "tcp"; host: string; port: number };

interface WireStream {
  write(frame: string): void;
  close(): void;                           // flush, then FIN
  terminate(): void;                       // drop immediately
  bufferedBytes(): number;                 // accepted but not yet flushed
  onFrame(handler: (frame: string) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
}

interface WireStreamServer {
  readonly target: StreamTarget;
  onConnection(handler: (stream: WireStream) => void): void;
  onError(handler: (error: Error) => void): void;
  endpoint(): StreamTarget;                // a TCP port 0 reports the bound port
  listen(): Promise<void>;
  close(): Promise<void>;
}
```

`FrameTooLargeError` distinguishes a framing violation from a transport failure. Frames that
arrive before `onFrame` is attached are buffered; a handler registered later still sees them.

### Transport policy

The protocol does not make transports equally trusted. A transport is enabled only with the
authentication model below.

| Target | Default | Authentication | Notes |
|---|---|---|---|
| Named pipe (`\\.\pipe\hlao-<hash>`) | yes | supervisor token | Per-user namespace; Windows ACLs. |
| Unix socket (`<HLAO_HOME>/supervisor.sock`) | yes | supervisor token | Created `0600`; the directory is the user's home. |
| Loopback TCP (`127.0.0.1`) | no | supervisor token plus an explicit opt-in | The adapter exists; the supervisor does not bind it by default. Any local process can connect. |
| Non-loopback TCP / TLS | no | dedicated credential, TLS, explicit config | The supervisor token is **not** a network credential. |
| WebSocket | no | origin allowlist plus a short-lived session credential | Intended for a browser client through an operator-initiated exchange. Never ship the supervisor token to page JavaScript. |

The supervisor token means "a local process that can read the runtime home is an operator"
(see *Endpoint and authentication*). That is a local trust statement. It must not be reused as
a network or browser credential.

### Transport and framing errors

| Condition | Supervisor | Client |
|---|---|---|
| Inbound frame over the limit | respond `bad_request`, close the stream | treat as `internal` ("response was too large") |
| Transport failure before a response | abort, close | `supervisor_unavailable` |
| Stream closed with no response | — | `supervisor_unavailable` |
| More than 64 requests in flight | respond `too_many_requests`, keep the connection | retry later |
| Subscriber buffer over 8 MiB | close the stream | reconnect with cursors |

Framing errors are reported before any method is dispatched, so they carry `id: 0`.

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
| `no_pending_elicitation` | `sessions.respond_elicitation` with nothing pending |
| `bad_option` | permission option id not offered by the request |
| `config_invalid` | user or project config is invalid; the message names the file |
| `session_failed` | a prompt turn failed for a reason the adapter reported |
| `timeout` | a supervisor-side bounded operation expired (connections, shutdown) |
| `too_many_requests` | a persistent connection has more than 64 requests in flight |
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
  be ignored. Known values: `backends.list`, `backends.sessions`, `recovery.receipts`,
  `session.usage`,
  `read.filters`, `read.before`, `wait.multi`, `stream.persistent`, `stream.subscribe`,
  `stream.resume`, `wait.settled`, `wait.filters`, `session.settled`, `session.lastEvent`,
  `send.messageId`, `send.idempotency`, `spawn.idempotency`, `spawn.createdBy`,
  `supervisor.lastCrash`, `prompt.injected`, `session.compaction`, `session.notices`,
  `session.plan`, `session.title`, `session.agent`, `session.messages`,
  `session.elicitation`, `spawn.resume`, `spawn.fork`, `read.time`, `read.regex`,
  `read.context`, `session.firstPrompt`, `send.steering`, `session.pendingPermissions`,
  `permit.request`.
- Adding an optional request field, a result field, a method, or an event type is a minor
  change. Changing or removing existing semantics is a major change.
- **2.0** removes the `scope` field and makes every session in an instance addressable by every
  caller. There is no per-session visibility filter. Isolation is a separate instance.
- **2.1** adds persistent connections, `stream.subscribe`, and resume. The 2.0 one-request
  lifecycle, envelope, errors, and frame limits are unchanged; a 2.0 client sees only new
  capabilities it may ignore.
- **2.2** adds `wait --until settled`, `change` filters, `SessionView.settled` and
  `lastEvent`, `shutdown.retainedDiscarded`, and corrects `nextSeq` to be a real cursor. All
  additions are optional; `idle` keeps its existing "no active turn" meaning.
- **2.3** adds message ids and idempotency to `sessions.send`, spawn idempotency and the
  skill toggle to `sessions.spawn`, `QueueItemView.id` and drop-by-id, and
  `SessionView.createdBy`. Every prompt result now carries `messageId`; a client that ignores
  it is unaffected.
- **2.4** adds `hello.lastCrash` (the lock owner this supervisor replaced after it stopped
  answering) and `prompt.sent.data.injected` (the skill version, path, and block count for
  the first prompt). Capabilities: `supervisor.lastCrash`, `prompt.injected`. Both are
  optional; a client that ignores them is unaffected.
- **2.5** adds optional provider-native fields to `SessionView` (`compaction`, `plan`, `title`,
  `agentName`, `agentVersion`), the `session.message` event type, normalized `plan.update`
  data, and structured `compaction` data. Capabilities: `session.compaction`,
  `session.notices`, `session.plan`, `session.title`, `session.agent`, `session.messages`.
  A client that ignores the fields and event type is unaffected.
- **2.6** adds provider elicitation: `sessions.respond_elicitation`, optional
  `SessionView.pendingElicitation`, and the `elicitation.requested`/`elicitation.resolved`
  event types. Capability: `session.elicitation`.
- **2.7** adds provider session resume and fork: `spawn.resumeSessionId`/`forkSessionId`,
  `SpawnResult.resumed`/`forked`, `SessionView.forkedFrom`, the `session.resumed` and
  `session.forked` event types, and optional `EventView.replay`. Capabilities:
  `spawn.resume`, `spawn.fork`. A client that ignores them is unaffected.
- **2.8** adds observation filters and a display fallback: `sessions.read` accepts
  `afterAt`/`beforeAt` (ISO timestamps), `regex` (interpret `grep` as a case-insensitive
  expression), and `context` (include retained neighbors around matches); `ReadResult` gains
  optional `matchedSeqs` when `context` is used; `SessionView` gains optional `firstPrompt`.
  Capabilities: `read.time`, `read.regex`, `read.context`, `session.firstPrompt`. A 2.7
  client that ignores them is unaffected.
- **2.9** adds mid-turn steering: `sessions.send` accepts `steer` (inject into the running
  turn when the target is busy and its adapter advertises `_session/steering`), `SendResult`
  gains optional `steered`, `SessionView` gains optional `steeringSupported`, and the
  `prompt.steered` event type marks the delivery. Capability: `send.steering`. A client that
  omits `steer` keeps the queued behavior.
- **3.1** adds provider session discovery: `backends.sessions`, which reads the adapter's
  own `session/list` for a backend and an optional cwd, joined to the live table. New
  types `ProviderSessionsParams`, `ProviderSessionView`, and `ProviderSessionsResult`; new
  capability `backends.sessions`. The read creates no HLAO session and stores no mapping.
  A resume or fork keeps the provider's mode; `BackendManifest.defaultMode` applies to new
  sessions only. It also adds `recovery.receipts`, a read of the historical spawn-receipt
  ledger (`parentProviderId` → `childProviderId`), live-joined for attachment status. The
  ledger is not liveness; capability `recovery.receipts`. A 3.0 client that does not call
  the method is unaffected.
- **3.0** is a breaking change: HLAO no longer owns a permission policy. Removed:
  `PermissionPolicy`, `SessionView.permissionPolicy`, `SessionView.pendingPermission`,
  `SpawnParams.permissionPolicy`, `sessions.set_policy`, `policy.changed`,
  `permission.requested.policy`/`auto`, and `PermitParams.always`. Added:
  `SessionView.pendingPermissions` (FIFO), `PermitParams.requestId`,
  `PermitResult.requestId`, `permission.requested.queuePosition`, and
  `AgentView.defaultMode`. Capabilities: `session.pendingPermissions`, `permit.request`.
  Every provider ask parks for the operator; `sessions.permit` and `sessions.set_mode` are
  operator-only. There is no compatibility shim. A live supervisor of another major is
  reported as `version_mismatch`, never replaced.

## Client model

- Call `hello` first. It reports the protocol version, capabilities, and supervisor health.
- Poll `sessions.list` for a fleet view and `sessions.read` with `nextSeq`/`nextBefore` for a
  session's log. Polling is the protocol 2.0 model and remains supported. A client that needs a
  live view may instead negotiate a persistent stream and subscribe (2.1); the supervisor owns
  no recurring timer either way.
- Use `sessions.wait` when a client would otherwise poll a blocking condition. It is one-shot:
  it resolves once and must be re-armed. A subscription does not change `wait`.
- All timestamps are ISO-8601 strings. Durations such as "pending for" are computed by the
  client.
- A client that wants a composite operation (`cancel` then wait, broadcast to a subtree, bulk
  permit) loops over these methods. Such compositions are client assemblies, not protocol
  concepts.

## Addressing

Every session in the instance is addressable by every caller. `callerSessionId` is recorded as
attribution but does not restrict addressing. `parentId`/`rootId`/`depth` are lineage, not
authority. The only isolation boundary is another instance (`HLAO_HOME`, socket, and token).

All `sessionId` params accept an exact handle first, then a unique session name, then a unique
handle prefix, resolved within **this HLAO instance**. Duplicate names are `ambiguous_id` with
`details.candidates`; the full handle still resolves.

## Methods

Method index:

| Method | Params | Result |
|---|---|---|| `hello` | `HelloParams` | `HelloResult` |
| `backends.list` | `{ cwd? }` | `{ backends: AgentView[] }` |
| `backends.sessions` | `{ backend, cwd?, cursor? }` | `ProviderSessionsResult` |
| `recovery.receipts` | `{ parentProviderId? }` | `{ receipts: RecoveryReceiptView[] }` |
| `sessions.spawn` | `SpawnParams` | `SpawnResult` |
| `sessions.list` | `{ includeClosed?, cwd? }` | `{ sessions: SessionView[] }` |
| `sessions.get` | `{ sessionId }` | `{ session: SessionView }` |
| `sessions.send` | `SendParams` | `SendResult` |
| `sessions.read` | `ReadParams` | `ReadResult` |
| `sessions.wait` | `WaitParams` | `WaitResult` |
| `sessions.cancel` | `{ sessionId, keepQueue? }` | `{ session, discarded }` |
| `sessions.close` | `{ sessionId, force? }` | `{ session, killed, wasTerminal }` |
| `sessions.permit` | `{ sessionId, optionId, requestId? }` | `{ session, requestId, optionId, by }` |
| `sessions.respond_elicitation` | `{ sessionId, requestId?, action, content? }` | `{ session, requestId, action, by }` |
| `sessions.set_mode` | `{ sessionId, modeId }` | `{ session }` |
| `sessions.set_config_option` | `{ sessionId, configId, value }` | `{ session }` |
| `sessions.queue` | `{ sessionId }` | `{ session, active, queue }` |
| `sessions.queue_drop` | `{ sessionId, position? \| messageId? }` | `{ session, dropped, discarded }` |
| `sessions.rename` | `{ sessionId, name }` | `{ session }` |
| `sessions.forget` | `{ sessionId }` | `{ sessionId, forgotten }` |
| `stream.subscribe` | `SubscribeParams` | `SubscribeResult` |
| `stream.unsubscribe` | `{ subscription }` | `{ subscription, removed }` |
| `supervisor.reload` | `{}` | `{ configHash, configError }` |
| `supervisor.shutdown` | `{ force? }` | `{ sessionsClosed, retainedDiscarded }` |

Shape names in this table are navigation labels. The inline TypeScript in each method section
is the authoritative definition.

### `hello`

Params:

```ts
{
  protocolVersion?: { major: number; minor: number }; // the client's version
  stream?: { persistent?: boolean };                  // request a persistent connection (2.1)
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
  configError?: string,       // present only for a reload-degraded supervisor
  lastCrash?: {               // present when the previous lock owner died (2.4)
    pid: number,
    version: string,
    startedAt: string,
    detectedAt: string
  },
  stream?: { persistent: boolean } // present when persistence was requested
}
```

An invalid user config is fatal at startup: the supervisor does not bind or create a lock, and
the client reports `config_invalid` before autostart. `configError` remains for a supervisor
that reloaded an invalid file after a valid start; in that state only new spawns are blocked.

`stream: { persistent: true }` is only valid on the first frame. On success the connection
stays open and every later frame is a request; the connection closes when either side does.
On a 2.0 supervisor the unknown `stream` field is `bad_request`, so a client that may meet an
older supervisor calls `hello` without it first and checks `stream.persistent` in the
capabilities.

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
  defaultMode?: string;       // operator's per-backend spawn mode (3.0)
};
```

### `backends.sessions`

Params:

```ts
{
  backend: string;   // a configured backend name
  cwd?: string;      // absolute cwd filter; omit to read the provider's catalog across cwds
  cursor?: string;   // opaque cursor from an earlier nextCursor
}
```

Result:

```ts
{
  backend: string;
  cwd: string | null;        // the filter used, or null when reading across cwds
  agentName: string | null;  // the adapter's initialize agentInfo
  agentVersion: string | null;
  sessions: ProviderSessionView[];
  nextCursor: string | null;
}

type ProviderSessionView = {
  sessionId: string;         // the provider's durable id, not an HLAO id
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  attached: boolean;         // a non-terminal HLAO session holds this provider id
  hlaoSessionId: string | null;
  hlaoName: string | null;
  hlaoStatus: SessionStatus | null;
  loadable: boolean;         // the adapter advertises ACP loadSession
  forkable: boolean;         // the adapter advertises ACP session/fork
};
```

This reads the provider's own catalog through ACP `session/list`; it is not an HLAO
session list and it stores no mapping. The supervisor starts a short-lived adapter,
checks `sessionCapabilities.list`, asks for one page, and kills the adapter. It creates
no HLAO session and no provider conversation. `attached` is a live lookup by provider id;
a row without it is provider-only and must not be presented as an HLAO session. A
provider session already live in this instance is marked attached; adopting it through
`sessions.spawn` returns a duplicate instead of opening a second adapter.

Errors: `backend_not_found`, `backend_unavailable`, `bad_request` when the adapter does
not advertise `session/list`, and `spawn_failed` when the probe cannot start, handshake,
or answer within `startupTimeoutMs`. The caller's abort signal kills the probe.

### `recovery.receipts`

Params:

```ts
{
  parentProviderId?: string; // filter to one parent's receipts; omit for every receipt
}
```

Result:

```ts
{
  receipts: RecoveryReceiptView[];
}

type RecoveryReceiptView = {
  parentProviderId: string;
  parentSessionId: string | null;  // historical HLAO id at attach time
  childProviderId: string;         // the durable handle to adopt
  childSessionId: string;          // historical HLAO id at attach time
  backend: string;
  cwd: string;
  name: string | null;
  recordedAt: string;
  attached: boolean;               // a non-terminal HLAO session holds the child id
  hlaoSessionId: string | null;
  hlaoName: string | null;
  hlaoStatus: SessionStatus | null;
  parentHlaoSessionId: string | null; // a non-terminal session holds the parent id
  parentHlaoName: string | null;
  parentHlaoStatus: SessionStatus | null;
};
```

This reads the append-only spawn-receipt ledger, not the live table. A receipt is written
when a parent spawns or reattaches a child and is keyed by the parent's provider id, so it
survives a supervisor restart. The result dedupes the same parent/backend/child triple to
its latest receipt and sorts newest first. It never creates a session, starts an adapter,
or claims a child is live; `attached` is only a live-table lookup. A malformed ledger line
is skipped. `--provider` on the CLI reads the same file with no supervisor.

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
  mode?: string;                 // operator-only; effective before the backend defaultMode
  model?: string;                // value for the option whose category is "model"
  config?: Record<string, string | boolean>; // session config options applied before the prompt
  parentSessionId?: string;      // lineage; defaults to the caller's live session, else a root
  env?: Record<string, string>;  // extra environment for the adapter
  skill?: boolean;               // include the HLAO skill pointer in the first prompt (default true)
  idempotencyKey?: string;       // reuse the session produced by an earlier spawn (2.3)
  resumeSessionId?: string;      // provider session id to reopen with ACP session/load (2.7)
  forkSessionId?: string;        // provider session id to copy with ACP session/fork (2.7)
}
```

Result:

```ts
{
  session: SessionView;
  nextSeq: number;               // always 0: pass as `since` to read from the beginning
                                 // (not a page cursor; see sessions.read nextSeq)
  firstTurn?: { stopReason: StopReason; text: string; timedOut: boolean };
  messageId?: string;            // the first prompt's id, when one was sent (2.3)
  duplicate?: boolean;           // the idempotency key matched an existing session (2.3)
  resumed?: boolean;             // this spawn reopened a provider session (2.7)
  forked?: boolean;              // this spawn copied a provider session (2.7)
  createdBy?: string;            // same value as session.createdBy (2.3)
}
```

`spawn.nextSeq` is a start-of-history cursor, not the page cursor that `sessions.read`
returns. It is always `0` so `read --since 0` returns the session's whole transcript,
including `session.created` and the first turn. The name is kept for wire compatibility.

The call resolves once `initialize` and `session/new` both succeed. If `prompt` is present
and `wait` is true, it also waits for the first turn (bounded by `sendWaitTimeoutMs`). A
timeout is reported as `firstTurn.timedOut = true`, not as an error.

`skill: true` prepends a short text block pointing at `<HLAO_HOME>/skills/hlao/SKILL.md` to
the first prompt only. `idempotencyKey` dedupes spawns for one hour (256 keys); a duplicate
returns the existing session and its first-prompt `messageId` without spawning. If that
session is no longer in the live table, the key is released.

`resumeSessionId` reopens a provider session with ACP `session/load` instead of
`session/new`. The provider replays its durable history as `session/update` notifications;
HLAO projects them as events with `replay: true`, then emits `session.resumed` with the
provider id and the replayed seq range. The interrupted turn is not replayed, so the caller
re-issues the prompt. A backend that does not advertise ACP `loadSession` is refused with
`spawn_failed` rather than started with an empty conversation under the same id. If a live
session in this supervisor already holds that provider id, the call returns that session
with `duplicate: true` and `resumed: true` instead of opening a second adapter against the
same transcript. The adapter creates the resumed query in the `cwd` it is given, so pass the
original cwd to keep one transcript.

`SessionView.agentSessionId` is the durable provider handle (for example the id
`claude --resume` accepts). The HLAO session id is an alias for this supervisor's lifetime.
An agent that spawned a session keeps the provider id in its own context and passes it back
as `resumeSessionId` after a restart.

`forkSessionId` copies a provider session with ACP `session/fork` instead of reopening it.
The source is never modified and keeps its own id; the new session gets a provider-assigned
id and `SessionView.forkedFrom` records the source. When the backend also advertises
`loadSession`, HLAO immediately loads the new session so the copied history is replayed with
`replay: true`; otherwise the fork starts with the copied context but sends no history.
`resumeSessionId` and `forkSessionId` are mutually exclusive.

A resume or fork continues an existing conversation. Its effective mode is the provider's
persisted mode; `backends.<name>.defaultMode` applies only to a new session. An explicit
operator `mode` still overrides. `ProviderSessionsResult` carries the provider row's cwd,
which is the safe default for a reconnect after a restart.

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
{
  sessionId: string;
  text: string;
  wait?: boolean;
  timeoutMs?: number;
  messageId?: string;            // caller-chosen; generated when omitted (2.3)
  idempotencyKey?: string;       // retry-safe delivery (2.3)
  steer?: boolean;               // inject into a running turn when possible (2.9)
}
```

`timeoutMs` defaults to `config.sendWaitTimeoutMs`; `0` means no timeout. The caller's session
id (or `"operator"`) is recorded as `prompt.sent.from` / `prompt.queued.from` /
`prompt.steered.from`.

With `steer: true` the supervisor asks the target's adapter to inject the prompt into the
turn that is already running (ACP `_session/steering`). Injection needs both an active turn
and a `SessionView.steeringSupported` adapter; otherwise the prompt takes the ordinary queue
path, so the call is always safe. A steered prompt has no turn of its own: the adapter folds
it into the running turn, events for it carry that turn's number, and `wait: true` waits for
that turn to settle. `completed: false, timedOut: false, steered: true` reports an injection
that the caller did not wait for. A session's send to itself always queues; steering is for
peer messaging, and the deferred self-send is the documented next-turn form.

Result:

```ts
{
  session: SessionView;
  messageId: string;             // msg-…, stable across retries (2.3)
  queued: boolean;               // true when this call put the message behind a running turn
  turn: number | null;           // null when not yet dispatched
  completed: boolean;
  timedOut: boolean;
  stopReason?: StopReason;
  text?: string;                 // accumulated agent text; partial on timeout (2.3)
  outcome?: "completed" | "cancelled" | "timed_out"; // (2.3)
  duplicate?: boolean;           // the idempotency key matched an earlier send (2.3)
  pending?: boolean;             // on a duplicate: the original is still active or queued
  steered?: boolean;             // injected into the running turn (2.9)
}
```

`timedOut: true` means the turn is still running; the caller should `read --since` later.
`completed: false, timedOut: false` is only possible when `wait` is false. A queued message
cancelled before it runs reports `completed: true`, `outcome: "cancelled"`, and a null `turn`.

A `wait: true` sent by a session that is itself inside a turn is rejected with `bad_request`
when it would close a wait cycle: the target is already blocked, directly or transitively, on
the caller's turn, so the message would queue behind a turn that cannot end. The error names
the chain (`wait cycle: A -> B -> A`). Send without `wait` so the message runs after the
current turn. The self-send case is the same rule with one session.

An `idempotencyKey` is remembered for one hour (256 keys, oldest evicted). A repeat returns
the original `messageId` with `queued: false` and `duplicate: true` — this call accepted no new
work — plus `pending`, which says whether the original message is still active or queued.

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
  afterAt?: string;              // keep events at or after this ISO timestamp (2.8)
  beforeAt?: string;             // keep events strictly before this ISO timestamp (2.8)
  regex?: boolean;               // interpret grep as a case-insensitive expression (2.8)
  context?: number;              // include 0..20 retained neighbors per match (2.8)
}
```

Filters are ANDed and applied while scanning, before the page limit and byte budget. A cursor
always advances past scanned events, not only returned events, so a filtered follower does not
rescan the same non-matching range. `grep` searches the event as returned: private payloads
require `raw: true`. `afterAt` is inclusive and `beforeAt` is exclusive; both are ISO-8601
timestamps. `regex: true` requires a non-empty `grep` and is validated at the boundary.
`context` is display-oriented: `limit` bounds matches, neighbors are added around each match,
and `matchedSeqs` reports which returned events matched. Cursors still advance by matches, so a
neighbor may repeat on the next page; a match is never skipped.

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
  nextSeq: number;                // last scanned seq: pass as since
  nextBefore: number | null;      // backward cursor: pass as before; null = no older page
  hasMore: boolean;               // more events in the scan direction
  truncated: boolean;             // history before the page was evicted
  matchedSeqs?: number[];         // seqs that matched; present when context was requested (2.8)
}
```

`nextSeq` is the last seq the page scanned, so passing it back as `since` returns the next
event without skipping or rescanning. For a forward page it is the last returned or scanned
event; for a tail or backward page it is `lastSeq`; for a reader ahead of the log it is the
caller's `since`. For a tail read (no cursor), `hasMore` is false; use `nextBefore` to page
backward. For a `since` read, `truncated` is true when `since + 1 < earliestRetainedSeq`. For
a `before` read, it is true when the scan reached the oldest retained event and earlier
history was evicted.

### `sessions.wait`

Params:

```ts
{
  sessionId?: string;            // exactly one of sessionId or sessionIds
  sessionIds?: string[];         // 1..100; no duplicate ids
  mode?: "any" | "all";          // default "any"; ignored for one id
  until: "idle" | "settled" | "permission" | "exit" | "change";
  since?: number;                // only for "change" with a single id
  types?: EventType[];           // only for "change": match these event types
  grep?: string;                 // only for "change": case-insensitive literal
  timeoutMs?: number;            // defaults to config.waitTimeoutMs; 0 = no timeout
}
```

Result:

```ts
{
  satisfied: boolean;            // aggregate
  reason: "idle" | "settled" | "permission" | "exit" | "change" | "timeout";
  waitedMs: number;
  results: {
    session: SessionView;
    satisfied: boolean;
    reason: "idle" | "settled" | "permission" | "exit" | "change" | "timeout" | "pending";
  }[];
  session?: SessionView;         // present only for a single-id request
}
```

The wait is one-shot: it resolves at the first matching condition and never re-arms. A
timeout never changes a session.

A wait issued by a session that is itself inside a turn participates in wait-cycle detection.
A state wait (`idle`, `settled`, `permission`, `exit`) on your own turn is rejected with
`bad_request` (`wait cycle: A -> A`): the condition cannot be reached while the turn is
blocked in the wait. A `change` wait on yourself is valid because a queued prompt emits its
event during the current turn, unless its `types` filter selects only events that follow the
turn (`prompt.sent`, `turn.started`, `turn.ended`). Cross-session state waits and `change` waits are rejected when
they would close a cycle with another session's in-flight wait; for a multi-id wait the
`any`/`all` mode decides whether a blocked target is fatal.

**`idle` vs `settled`.** `idle` means no active turn. A session can be idle with queued
prompts between turns, so `idle` is not a completion signal. `settled` means no active turn
**and** an empty queue; it is also satisfied by `waiting_permission` and by a terminal session.
With `until: "settled"`, the per-target `reason` names the condition that matched (`idle`,
`permission`, or `exit`). For a multi-id `all` wait, the aggregate `reason` is `exit` if any
target ended, otherwise `settled`; an `any` wait reports the first satisfied target's reason.

With several ids, `any` resolves on the first target that satisfies and `all` when every target
does. For `idle`, `permission`, and `change`, a target that ends first is unsatisfied with
reason `exit`; for `all`, that resolves the whole wait immediately. A target that is not
settled when the aggregate resolves is evaluated at that moment: it is reported as satisfied
if it already meets the condition, otherwise as `pending`. `change` uses each target's
`lastSeq` at call time as its baseline; `since` is rejected with more than one id. `types` and
`grep` filter the event that satisfies `change` and are rejected with any other condition. All ids
are resolved in this instance before waiting; one unknown or ambiguous id fails the request.

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

Params: `{ sessionId: string; optionId: string; requestId?: string }`.

Result: `{ session: SessionView; requestId: string; optionId: string; by: "operator" }`.

**Operator-only:** a request with `callerSessionId` is refused with `operator_only`. Answers
one queued provider request with an option id the provider offered. The queue is FIFO; with
more than one request pending, `requestId` is required and its absence is a `bad_request`
that names the pending ids. An unknown `requestId` is `no_pending_permission` carrying the
pending ids. A missing `optionId` fails boundary validation. Errors: `bad_option`,
`no_pending_permission`, `operator_only`.

The relay rules (3.0):

- Every ACP permission request parks, including one that arrives outside a turn
  (`outsideTurn: true`). There is no auto-answer.
- `SessionView.pendingPermissions` is the queue in arrival order. `permission.requested`
  carries `queuePosition` (1-based) for an enqueued request.
- `maxPendingPermissions` (config, captured at spawn) bounds the queue. A request beyond the
  bound is not enqueued: the provider is answered `cancelled` and
  `permission.resolved { by: "system", reason: "queue_full", optionId: null }` is recorded.
- `permissionTimeoutMs` (config, captured at spawn) is one absolute one-shot deadline per
  request. On expiry the supervisor selects `reject_once`, then `reject_always`, else
  cancels; it never selects an allow option, and records
  `permission.resolved { by: "timeout", reason: "timeout", optionId }`.
- Timers are cleared on answer, provider withdrawal, cancel, and close. A withdrawal clears
  only its own request; cancel and close clear every request.
- The session stays `waiting_permission` while any request remains. `wait --until
  permission` and `list --pending` match any pending request.

### `sessions.respond_elicitation`

Params: `{ sessionId: string; requestId?: string; action: "accept" | "decline" | "cancel";
content?: Record<string, string | number | boolean | string[]> }`.

Result: `{ session: SessionView; requestId: string; action: "accept" | "decline" | "cancel";
by: "operator" }`.

Answers a provider question (ACP `elicitation/create`) exposed as
`SessionView.pendingElicitation`. `accept` carries schema-shaped content; `decline` answers
with no content; `cancel` withdraws the question and the provider aborts the tool call. An
elicitation is user input, not a permission: the operator-only permit relay never answers
it. Errors: `no_pending_elicitation` when nothing is pending or `requestId` does not match.

### `sessions.set_mode`

Params: `{ sessionId: string; modeId: string }`. Result: `{ session: SessionView }`.

**Operator-only:** a request with `callerSessionId` is refused with `operator_only`; reads
stay open through `sessions.get`. Switches the provider's native session mode when the
adapter advertises modes. The mode is the permission policy; HLAO does not normalize mode
names. The session view reports `modes: { currentModeId, availableModes }`. Errors:
`bad_request` when the backend advertises no modes, `bad_option` when the mode is not in the
advertised list, `operator_only`, and `session_closed` for a terminal session. `spawn` mode
resolution is operator `--mode` → `BackendManifest.defaultMode` → the provider's default; an
agent caller may not supply `mode`.

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
  id: string;                    // msg-…; also on prompt.sent/queued/discarded (2.3)
  from: string;                  // sender session id or "operator"
  queuedMs: number;
  turn: number | null;
};
```

### `sessions.queue_drop`

Params: `{ sessionId: string; position?: number; messageId?: string }` — exactly one of
`position` (1..1000) or `messageId` (2.3).
Result: `{ session: SessionView; dropped: QueueItemView; discarded: number }`.

Removes one queued prompt. The prompt is settled as cancelled before it runs and emits
`prompt.discarded` with `reason: "dropped"`, `messageId`, `position`, and the actor.
Out-of-range positions and ids that are not queued are `bad_request` and do not change the
queue.

### `stream.subscribe`

Persistent streams only. A subscription reports session views and, for explicitly named
sessions, streams their events. It is event-driven: notifications are emitted at the same
append point that wakes `sessions.wait`, and the supervisor creates no timer.

Params:

```ts
{
  sessionIds?: string[];                    // 1..100; events and views for these ids
  fleet?: boolean;                          // views for every session, including new ones
  since?: Record<string, number>;           // per-session resume cursor: seq the client has
}
```

At least one of `sessionIds` or `fleet: true` is required. Ids resolve by the usual rules.
One connection may hold at most 64 subscriptions (`too_many_requests`).

Result:

```ts
{
  subscription: number,
  sessions: SessionView[],                  // current views for the view scope
  cursors: Record<string, number>,          // last delivered seq per session
  truncated: string[]                       // ids whose history was evicted before `since`
}
```

`fleet` controls the view scope. `sessionIds` controls the event scope; a fleet subscription
with `sessionIds` does both. A subscription with only `fleet` does not stream events: polling
`sessions.read` for an open session remains the client's choice, and a dashboard usually
subscribes once for the fleet and once for the session it is showing.

View notifications (`kind: "session"`) are sent when a session's `SessionView` changes; the
first notification after a reconnect is a full view, so a client can replace local state.
New sessions in a fleet scope appear automatically. A session removed from the live table
(`forget` or retention expiry) produces `kind: "session.removed"` exactly once.

Event notifications are batched per session. `cursor` is the seq of the last delivered event;
pass it back as `since[id]` on reconnect. If events were evicted, the notification has
`truncated: true` and starts at the earliest retained event. The server closes a consumer that
lets more than 8 MiB sit in its outbound transport buffer; the client reconnects and resumes.
At most 64 requests may be in flight on one connection (`too_many_requests`).

### `stream.unsubscribe`

Persistent streams only.

Params: `{ subscription: number }`.
Result: `{ subscription: number; removed: true }`.
Errors: `not_found` when the connection has no such subscription.

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

Result: `{ sessionsClosed: number; retainedDiscarded: number }`. The supervisor replies, then
exits. `force` skips graceful ACP closes. `retainedDiscarded` counts terminal sessions that
were still in the live table; their event logs are lost with the supervisor.

## Notifications

A persistent connection carries two kinds of server frame. Responses have `id` and `ok`;
notifications have `type: "notification"`.

```ts
type NotificationFrame =
  | { type: "notification"; subscription: number; kind: "session"; session: SessionView }
  | { type: "notification"; subscription: number; kind: "session.removed"; sessionId: string }
  | { type: "notification"; subscription: number; kind: "event";
      sessionId: string; events: EventView[]; cursor: number; truncated: boolean };
```

Notifications are never interleaved inside a frame. Per-session event order is the event
log's sequence; across sessions, notifications follow the order in which the supervisor
observed the changes. A client must not assume a response and a notification that describe
the same change arrive in a particular order relative to each other.

## Event view

```ts
type EventView = {
  seq: number;                   // 1-based, strictly increasing per session
  at: string;                    // ISO-8601
  type: EventType;
  turn: number | null;
  data: Record<string, unknown>; // raw:true adds data.raw = original ACP update
  replay?: true;                 // rebuilt by session/load, not observed live (2.7)
};

type EventType =
  | "session.created" | "session.initialized" | "session.resumed" | "session.forked"
  | "session.renamed"
  | "session.closed" | "session.failed"
  | "prompt.sent" | "prompt.queued" | "prompt.steered" | "prompt.discarded"
  | "turn.started" | "turn.ended" | "cancel.requested"
  | "agent.message" | "agent.thought" | "user.message" | "session.message"
  | "tool.call" | "tool.update" | "plan" | "plan.update"
  | "permission.requested" | "permission.resolved"
  | "elicitation.requested" | "elicitation.resolved"
  | "notice" | "usage" | "mode" | "config" | "commands" | "session.info"
  | "compaction" | "subagent" | "stderr" | "error" | "raw";
```

Event ordering per session is total and monotonic. An event is appended before any waiter
that depends on it is notified.

Message text is streamed as deltas, not one record per message. `agent.message`,
`agent.thought`, and `user.message` each project one ACP chunk; `session.message` marks its
chunks with `chunk: true`. Concatenate chunks in `seq` order per `messageId` (which may be
`null`) when the full text matters; there is no separate assembled-message event. Human
`read` output joins adjacent chunks for display, but `read --grep`, `find`, and
`wait --until change --grep` match one event at a time, so a phrase split across chunks is
not found by a text filter. Wait on a state (`settled`, `turn.ended`) or assemble chunks
client-side instead.

Actor fields are explicit:

- `prompt.sent`, `prompt.queued`, and `prompt.steered` carry `from`: a session id or
  `"operator"`, plus the message id as `messageId` (2.3). `prompt.steered` (2.9) also carries
  the injected `text` and the turn it joined; it does not start a turn. The first prompt that
  carries the skill pointer also
  carries `injected: { skill, path, blocks }` (2.4); the pointer is marked delivered only
  after the provider accepts the prompt, so a failed request is retried with the next prompt.
- `prompt.discarded` carries the original `from`, the acting `by`, `reason`, a bounded
  `textPreview`, and `messageId` (2.3).
- `session.created` carries `createdBy`: `"operator"` or the requesting session id (2.3).
- `permission.resolved`, `mode`, `config`, `cancel.requested`, `session.renamed`, and
  `session.closed` carry `by`: the caller session id, `"operator"`, `"agent"` when the
  provider withdrew a request or changed a mode/config option, `"system"` for a queue
  bound, or `"timeout"` for the deadline.
- `permission.requested` (3.0) carries `requestId`, `toolCallId`, `title`, `kind`,
  `options`, and `outsideTurn`; `queuePosition` (1-based) is present when the request was
  enqueued. `permission.resolved` carries `requestId`, `optionId` (nullable), optional
  `optionName`, `by`, optional `reason`, and optional `note`. `by: "system"` with
  `reason: "queue_full"` and `by: "timeout"` with `reason: "timeout"` are the bound
  outcomes; a provider withdrawal is `by: "agent", reason: "withdrawn"`.

Provider-native events (2.5) are structured; `raw` is not required to read them:

- `compaction` carries `compactionId`, and either a `status` plus optional `summary`/`error`
  (`compaction_update`) or `text` with `chunk: true` (`compaction_summary_chunk`). Later
  updates with the same id patch the entity; chunks append to its summary.
- `plan.update` keeps the ACP `update` object for compatibility and adds `planId`, `kind`
  (`items`/`file`/`markdown`), and the matching `entries`, `uri`, or `content`. A removal is
  `{ removed: true, planId }`.
- `session.message` carries `messageId`, `senderSessionId`, `recipientSessionId`, `text`, and
  `chunk`. It is the first-class projection of ACP `session_message`/
  `session_message_chunk`; the raw ACP content remains under `raw`. ACP gates these updates
  on the experimental `subagents` capability, which HLAO deliberately does not advertise; a
  compliant adapter will not send them, and HLAO still projects them if a custom adapter does.
- `session.info` carries the provider `title`; `session.initialized` carries `agentName` and
  `agentVersion`, plus `resumed: true` when the session was reopened, or `forked: true` and
  `forkedFrom` when it was copied (2.7).
- `session.resumed` (2.7) carries `agentSessionId`, `historyStartSeq`, `historyEndSeq`, and
  `historyEvents`. Every event between the start and end seq is marked `replay: true`.
- `session.forked` (2.7) carries `agentSessionId`, `forkedFrom`, `historyLoaded`,
  `historyStartSeq`, `historyEndSeq`, and `historyEvents`. `historyLoaded: false` means the
  backend could not replay the copy; the forked agent still has the copied context.
- A `notice` may be derived from a `usage` update at 75% and 90% of the context size; the
  notice severity is `warning` then `error`, and the thresholds reset below 70%. This is
  derived state, not a timer.

## Session view

```ts
type SessionView = {
  id: string;                    // 6-char handle
  name: string | null;
  createdBy: string | null;      // "operator" or the requesting session id (2.3)
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
  settled: boolean;              // status idle && queued === 0 (2.2)
  lastSeq: number;
  lastEvent: {                   // most recent event, for fleet views (2.2)
    type: EventType;
    title: string | null;        // bounded; renderers sanitize it
    at: string;
  } | null;
  pendingPermissions: PermissionView[]; // FIFO; empty when none (3.0)
  pendingElicitation?: ElicitationView | null; // 2.6
  lastStopReason: StopReason | null;
  agentSessionId: string | null; // durable provider handle; pass as spawn.resumeSessionId (2.7)
  forkedFrom?: string | null;    // provider id this session was forked from (2.7)
  processId: number | null;
  exit: { code: number | null; signal: string | null } | null;
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
  compaction?: {                 // latest provider compaction (2.5)
    id: string;
    status: string;
    summary: string | null;
    error: string | null;
    updatedAt: string;
  } | null;
  plan?: {                       // latest provider plan (2.5)
    planId: string | null;       // null for a full ACP plan without an ID
    kind: "items" | "file" | "markdown";
    entries?: { content: string; priority: string; status: string }[];
    uri?: string;
    content?: string;
    updatedAt: string;
  } | null;
  title?: string | null;         // provider session title (2.5)
  firstPrompt?: string | null;   // bounded display-only preview of the first prompt (2.8)
  agentName?: string | null;     // provider agent identity (2.5)
  agentVersion?: string | null;
  steeringSupported?: boolean;   // adapter accepts `_session/steering` (2.9)
};

type PermissionView = {
  requestId: string;
  toolCallId: string | null;
  title: string;
  kind: string | null;
  options: { optionId: string; name: string; kind: string }[];
  requestedAt: string;
};

type ElicitationView = {          // 2.6
  requestId: string;
  toolCallId: string | null;
  message: string;
  mode: string;                   // "form" (requestedSchema) or "url" (url)
  requestedSchema?: Record<string, unknown>; // JSON Schema object
  url?: string;
  elicitationId?: string;
  requestedAt: string;
};
```
