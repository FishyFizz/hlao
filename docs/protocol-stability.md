# Protocol stability for a dashboard client

**Evaluated:** 2026-10-21, HLAO 0.16.0, wire protocol 3.1.
**Question:** is the current frame protocol stable enough to start a dashboard side project?
**Verdict:** **Yes, with a versioned, capability-aware client.** The frame format, persistent
stream, subscriptions, view/event notifications, and resume cursors are implemented, documented,
and exercised by the raw-client tests. A dashboard can start now. Three conditions matter:

1. Require wire **major 3** and feature-detect capabilities; do not key behavior off the
   package version or a minor number. Protocol 3.0 is a deliberate break: it removes the
   policy surface and replaces `pendingPermission` with `pendingPermissions`. Protocol 3.1
   is additive: it adds `backends.sessions` for provider discovery and
   `recovery.receipts` for historical spawn receipts. An old-major supervisor
   is reported as `version_mismatch` and is never replaced; stop it with the old CLI (or
   `hlao down`, which uses the legacy connection path) before starting 3.x.
2. Use a **local process** (Node/Tauri/Electron) that can open the named pipe/Unix socket and
   read the token. A browser needs a local frame bridge; it must never receive the supervisor
   token.
3. Treat event `data` as an open object and leave UI space for the provider-state fields 0.11
   will add (compaction, plan, title, agent identity).

## What is stable

- **Frame contract.** One JSON object per frame, ordered, reliable, bidirectional, boundaries
  preserved, bounded at 16 MiB per request. NDJSON for byte-stream transports. The contract is
  `contracts/protocol.md`; the transport seam is `src/stream.ts`. The protocol is defined over
  frames, not over the socket, so a future WebSocket/bridge adapter does not change methods.
- **Versioning.** `hello.protocolVersion` is `{major, minor}`. Major equality is required;
  minor additions are backward-compatible; `hello.capabilities` is the feature-detect list.
  Major 2 ran from 0.4 through 0.14 and every minor addition was optional. Major 3 (0.15)
  is the first deliberate break: it removes `permissionPolicy`, `pendingPermission`,
  `sessions.set_policy`, and `policy.changed`; adds `pendingPermissions`,
  `permission.requested.queuePosition`, `PermitParams.requestId`, and `AgentView.defaultMode`;
  and makes `sessions.permit`/`sessions.set_mode` operator-only. There is no compatibility
  shim. 3.1 adds `backends.sessions` (provider catalog, live-joined) and
  `recovery.receipts` (historical parent/child provider-id receipts) without changing an
  existing method; a 3.0 client can ignore them.
- **Persistent streams.** `hello` with `stream: {persistent: true}` opens a multiplexed
  connection. Requests carry a client-chosen `id`; responses echo it. The server may send
  notification frames. The legacy one-request-per-connection path remains, so a dashboard can
  fall back to polling if it meets an older supervisor.
- **Subscriptions.** `stream.subscribe`:
  - `fleet: true` reports a `SessionView` for every session, including new sessions, and emits
    `kind: "session.removed"` exactly once when a session leaves the live table (forget or
    retention expiry).
  - `sessionIds` (1..100 per subscription) streams batched events for those sessions, with a
    per-session cursor and a `truncated` flag.
  - A subscription can do both. At most 64 subscriptions and 64 in-flight requests per
    connection.
  - The initial result includes current views, cursors, and ids whose history was evicted.
- **Live state.** `SessionView` is the state projection: status, turn, queue depth, settled,
  the pending permission queue, modes, config options, usage/cost, last event, and lineage. View
  notifications are full `SessionView` objects, JSON-diffed server-side; the first notification
  after a reconnect is a full view, so replacing local state is safe.
- **Events.** `EventView` has `seq`, `at`, `type`, `turn`, and `data`. The event-type taxonomy
  is documented. Event notifications are batched (up to 200 events per page, up to 4 pages per
  session per flush), carry the last delivered cursor, and report truncation.
- **Resume.** Pass the last cursor as `since` on `stream.subscribe` (and `stream.resume` is a
  capability). If history was evicted before the cursor, the initial result and event
  notification set `truncated`; the client resumes from `earliestRetainedSeq`.
- **Backpressure.** The supervisor closes a consumer that lets more than 8 MiB sit in its
  outbound buffer. This is deliberate: a slow client is disconnected, not allowed to block the
  session table; it reconnects and resumes. Rule: never treat a stream close as data loss until
  resume reports truncation.
- **Control surface.** A dashboard can perform every orchestration operation the CLI does
  through the wire: spawn, send, cancel, close, permit, mode, config options, queue, rename,
  read, wait, list, get, export via paging, reload, shutdown, and backend listing.
  `sessions.permit` and `sessions.set_mode` are operator-only: a dashboard is an operator
  client and must not send `callerSessionId`. Reads, including `pendingPermissions`, stay
  open to agents. Client-only assemblies (`find`, bulk selectors, `@last`) remain client
  loops. Local diagnostics (`logs`, `config show`, `skill`, `doctor`) are CLI-local; `hello`,
  `backends.list`, and `reload` are on the wire.

## What is tested, and what is only contracted

The raw-client tests (`tests/e2e/persistent-stream.test.ts`, `protocol-client.test.ts`,
`wire-contract.test.ts`) cover:

- persistent handshake and capability advertisement;
- multiplexed requests and the 64-request in-flight cap;
- fleet + session subscription, initial views/cursors, event history, event batches with
  cursors, session view notifications, `session.removed` on forget, and unsubscribe;
- the legacy one-request path;
- wire validation and error envelopes.

Contract statements that a dashboard should treat as dependencies and test in its own client:

- automatic `session` view notification for a **new** session in a fleet scope;
- `session.removed` on **retention expiry** (the forget path is tested);
- reconnect + `since` resume after a backpressure close;
- `truncated` resumption from `earliestRetainedSeq`;
- multiple concurrent subscriptions on one connection;
- notification/response interleaving order (do not assume an order; make state application
  idempotent).

These are implemented in `#flush`/`#subscribe`, but the dashboard's reconnect and truncation
handling should be exercised against a slow/stalled consumer before it is trusted.

## Recommended dashboard shape

1. **Startup:** read `<HLAO_HOME>/supervisor.json` (endpoint + token) or ask the operator for
   the home. Call `hello` without persistence first; require `protocolVersion.major === 3`,
   and check `stream.persistent`, `stream.subscribe`, and `stream.resume` before using push.
2. **Persistent connection:** call `hello` again with `stream: {persistent: true}` (or send the
   persistent hello first if the supervisor is known to be 2.1+).
3. **Subscriptions:**
   - one `fleet: true` subscription for the session list/state;
   - one `sessionIds: [...]` subscription for the session(s) whose transcript is on screen.
     A fleet-only subscription does not stream events. When the fleet reports a new session and
     the user selects it, add it to the event subscription by resubscribing (there is no
     "update subscription" method; unsubscribe and subscribe with the new id set, passing the
     current cursors).
4. **State:** apply full `SessionView` notifications by id. Apply event batches by appending to
   the per-session log; advance the cursor to `notification.cursor`. Ignore duplicate or
   out-of-order events by seq. A response and a notification describing the same change may
   arrive in either order.
5. **Reconnect:** on close, reconnect with backoff, call `hello`, resubscribe with the last
   cursors, and replace views from the initial result. If `truncated` is set, mark the missing
   range in the transcript rather than pretending the history is complete.
6. **Rendering:** render known event types; fall back to a generic `type · title/preview` row
   for unknown types. Do not require `data.raw`; `--raw`-style payloads are a debug path, not a
   UI contract. Treat `EventView.data` as `Record<string, unknown>` and ignore unknown fields.
7. **Auth/transport:** a local app may hold the token. A browser must use a local bridge that
   speaks frames and authenticates its own UI; do not put the supervisor token in a page, and
   do not build a second semantic protocol. The network transport policy (TLS, credentials,
   WebSocket) is not shipped; local IPC is the supported dashboard transport today.
8. **Capabilities to gate:** `stream.persistent`, `stream.subscribe`, `stream.resume`,
   `session.usage`, `session.settled`, `session.lastEvent`, `send.messageId`,
   `spawn.resume`, `spawn.fork`, `backends.sessions`, `recovery.receipts`, `read.time`, `read.regex`,
   `read.context`, `session.firstPrompt`, `session.pendingPermissions`, `permit.request`,
   and the 2.5 provider-state capabilities (`session.compaction`,
   `session.notices`, `session.plan`, `session.title`, `session.agent`, `session.messages`).
   A missing capability means "render the old view", not "fail the dashboard". A dashboard
   without `spawn.resume` must keep reporting evicted history as unrecoverable; one with it
   can offer "open the provider transcript" instead. Without `backends.sessions`, keep the
   manual provider-id input; with it, offer the provider catalog picker. The catalog read is
   on demand and starts an adapter, so load it when the user opens the provider-session
   surface, not on every render. Without `recovery.receipts`, keep recovery manual; with it,
   show the historical receipts and offer provider-id resume. A receipt is history, not a
   live attachment.

## Known gaps and how to handle them now

- **Fleet events are a client assembly.** `fleet` is views only; per-session events require
  the ids in `sessionIds`. `hlao watch` is the reference implementation: chunk the target set
  to the 100-id limit, keep per-session cursors, attach new sessions by resubscribing, and
  reconnect with the same cursors. A dashboard can reuse that pattern; there is no
  supervisor-side merged stream or fleet event scope.
- **Provider-native state is first-class as of 0.11.** Compaction, plans, titles, agent
  identity, and ACP session messages are projected into `SessionView` and structured events.
  Gate them on the `session.compaction`, `session.notices`, `session.plan`, `session.title`,
  `session.agent`, and `session.messages` capabilities; an older supervisor simply lacks the
  fields, so render the basic view. Leave no dependency on `raw`.
- **No wire `logs`/`config show`/`find`/`usage` aggregation.** These are CLI-local or client
  assemblies. A dashboard that needs supervisor logs must read the file locally (as `hlao logs`
  does) or wait for a wire method; do not infer them from events. Usage per session is in
  `SessionView`; `hlao usage` aggregates it client-side and there is no wire aggregation
  method. Time/regex/context reads are on the wire (2.8) and are reusable by any client.
- **No heartbeat.** Local IPC closes reliably when the supervisor dies; a bridge over a
  network transport should add its own heartbeat above the frame layer. The wire itself adds no
  timer, by design.
- **Loose event payloads.** `EventView.data` is untyped and provider updates can be
  experimental. The dashboard must be defensive: known `type` + optional fields, generic
  fallback, no assumptions about `_meta` or content-block shape.
- **Token is full operator authority.** Never expose `supervisor.json` or the token to a web
  origin. A dashboard bridge should have its own auth and should forward frames, not reimplement
  semantics (ADR 0009).

## Go/no-go checklist

- [ ] Client requires `hello.protocolVersion.major === 3`.
- [ ] Client checks `stream.persistent`, `stream.subscribe`, `stream.resume` before push.
- [ ] Fleet subscription drives the session list; a per-session subscription drives the
      transcript; new sessions are added by resubscribing.
- [ ] Reconnect + `since` resume is implemented and tested against a closed stream.
- [ ] `truncated` is surfaced in the transcript, not hidden.
- [ ] Unknown event types and fields have a generic fallback.
- [ ] The token never reaches a browser origin.
- [ ] The UI has optional slots for compaction, plan, title, first prompt, and agent identity,
      gated on the 2.5/2.8 capabilities.
- [ ] Read time/regex/context filters are offered only when the corresponding capability is
      present.

**Conclusion:** the dashboard can start now against wire major 3 with capability detection,
and 3.1's provider catalog is an optional picker rather than a prerequisite.
0.13's observation additions are in wire 2.8 and are additive; a 2.7 client ignores them, so
the same view can grow without a protocol break or a second surface.
