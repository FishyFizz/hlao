# ADR 0009 — The wire is a frame stream, not a transport

**Status:** accepted, 2026-10-20 (milestone 0.6). Layer 1 (transport adapter) and Layer 2
(persistent multiplexed streams, protocol 2.1) are implemented. Network transport policy and
the WebSocket adapter remain planned in `docs/milestones/0.6.md`.

## Context

ADR 0007 made the supervisor socket the client boundary: one wire, many clients, no private
access. The wire it fixed is NDJSON over a per-user named pipe or Unix socket, with one
request per connection, a response, then close. That was right for the CLI, which is stateless
and runs one request per command.

It is the wrong shape for every other client we now want:

- A browser cannot open a named pipe or a Unix socket at all.
- Every request needs the token from `<HLAO_HOME>/supervisor.json`. A browser that held it
  would hand full operator authority to any page that could read it.
- One request per connection means a live view is polling-by-process. `sessions.wait` softens
  this, but a dashboard still reconnects for every page.
- A "dashboard bridge" that translates the socket to HTTP/SSE would be a second implementation
  of the wire. ADR 0007 rejects a second protocol for good reason: two implementations drift,
  and one becomes the real contract.

At the same time, the protocol is already almost transport-independent. The request envelope
has a client-chosen `id`, the response echoes it, and everything above the socket is JSON.
The transport coupling is a few dozen lines of `node:net` in the supervisor, client, and
liveness probe.

Transports are also not interchangeable in trust. Named pipe and Unix socket are local IPC
protected by user boundaries and file permissions. Loopback TCP is reachable by any local
process. A TLS listener on another host is a network service. WebSocket in a browser adds an
origin and a page-script threat model. Treating them as equivalent would move the supervisor's
authority boundary without saying so.

## Decision

1. **The protocol is defined over application frames, not over a socket.** A frame is one JSON
   object that satisfies the envelope. The required stream properties are: ordered, reliable,
   bidirectional, frame boundaries preserved, and a bounded frame size. `contracts/stream.md`
   is the public statement of that contract.

2. **Encodings are adapter details.** Byte-stream transports (named pipe, Unix socket, TCP)
   use NDJSON: one frame per `\n`-terminated line, and a frame may span chunks. Message-oriented
   transports (WebSocket) carry one frame per message and add no delimiter. SSE is not a stream
   under this contract on its own: it is unidirectional, so it is only usable as a composed
   adapter with a separate request channel.

3. **Transport adapters sit behind one interface.** `WireStream` owns framing, buffering, and
   close/error delivery; `WireStreamServer` owns listening. `src/stream.ts` is the only core
   module that imports `node:net`. Adding a transport means adding a `StreamTarget` variant and
   an adapter, not changing a method.

4. **Each transport declares its trust and authentication model.** The supervisor token is
   local-IPC authority. It authenticates the local pipe and Unix socket. A network transport
   must not accept the supervisor token as its credential: it requires its own opt-in config
   and credential, and a browser never receives the supervisor token. A transport that cannot
   state its policy is not enabled.

5. **Persistence and push are protocol capabilities, not client tricks.** A persistent
   connection multiplexes requests by `id` and may carry server-initiated frames. Notifications
   are emitted at the same append point that already notifies waiters, so they are
   event-driven; the supervisor gains no timer and no second authority over session state.
   The legacy one-request-per-connection path remains.

6. **Versioning follows observed behavior.** Replacing the transport implementation without
   changing the frame format is not a protocol change. Persistent sessions, subscriptions, and
   resume are additive minor capabilities (`stream.persistent`, `stream.subscribe`,
   `stream.resume`) negotiated through `hello`. A protocol major is required only if the legacy
   frame or lifecycle is removed.

## Consequences

- `supervisor`, `client`, and `lock` stop depending on `node:net`; `stream` becomes the single
  transport seam. The behavior of protocol 2.0 is unchanged.
- A non-CLI client in another language can implement the frame contract without reimplementing
  HLAO. A conformance test can run the same suite against any adapter.
- A web dashboard still needs a credential exchange operator action, but it does not need a
  semantic bridge. The bridge, if one exists, is a dumb frame proxy.
- A slow persistent client can become a memory risk. Push requires a bounded per-connection
  queue and resume-by-cursor; a consumer that falls behind is disconnected and re-syncs from
  `lastSeq`, never blocks the session table.
- The network surface is a separate decision. Nothing in this ADR enables remote access by
  default.

## Alternatives rejected

- **A dashboard bridge as the answer.** It works, but it is a second wire implementation and a
  second place for protocol drift. It remains acceptable as a deployment artifact only if it
  forwards frames without interpreting methods.
- **SSE as a peer transport.** SSE carries server-to-client only. Without an uplink it cannot
  satisfy the bidirectional stream contract.
- **Expose the supervisor token to the browser to avoid a bridge.** The token is operator
  authority. This turns every XSS in the dashboard into control of every session.
- **Put the dashboard or its view model in core.** Presentation changes constantly; core owns
  state and authority. The stream module moves frames and knows nothing about sessions.
- **Make persistent connections the default.** The CLI's one-request-per-command model is a
  robustness feature: a wedged long-lived connection must never wedge `hlao list`.
