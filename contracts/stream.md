# Contract — `stream`

The transport contract under the wire protocol. `contracts/protocol.md` defines what a frame
means; this contract defines what a stream must provide for those frames to be delivered.
ADR 0009 records the decision.

```
methods (sessions.*, hello, ...)     semantics
        │
   RequestEnvelope / Response        frames
        │
     WireStream                      this contract
        │
  pipe / unix socket / TCP / ...     adapters
```

## The frame

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

## Lifecycle (protocol 2.0)

Today, one connection carries exactly one request:

1. The client connects.
2. The client writes one request frame.
3. The supervisor writes one response frame.
4. The supervisor closes the stream.

The supervisor ignores frames after the first on a connection and closes after replying. A
stream that sends no frame within 15 s is closed. This is the legacy path and remains
supported; it is what the bundled CLI uses.

Persistent multiplexed streams are **not** part of protocol 2.0. They are planned as additive
capabilities:

- `stream.persistent` — the connection stays open and carries many requests, correlated by
  the client-chosen `id`. Responses may be out of order.
- `stream.subscribe` — the client registers interest in fleet and per-session changes; the
  server emits notification frames at state-append time.
- `stream.resume` — a reconnect supplies per-session cursors so the server replays from
  `seq > cursor`, or reports `truncated`.

None of these changes `wait`: it remains one-shot. Push and wait are two ways to observe the
same append point, not two authorities.

## Adapter interface

`src/stream.ts` exports the seam. Other clients may implement the same shape:

```ts
type StreamTarget =
  | { kind: "path"; path: string }        // named pipe or Unix socket
  | { kind: "tcp"; host: string; port: number };

interface WireStream {
  write(frame: string): void;
  close(): void;                           // flush, then FIN
  terminate(): void;                       // drop immediately
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

## Transport policy

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
(`contracts/protocol.md`). That is a local trust statement. It must not be reused as a network
or browser credential.

## Errors

| Condition | Supervisor | Client |
|---|---|---|
| Inbound frame over the limit | respond `bad_request`, close the stream | treat as `internal` ("response was too large") |
| Transport failure before a response | abort, close | `supervisor_unavailable` |
| Stream closed with no response | — | `supervisor_unavailable` |

Framing errors are reported before any method is dispatched, so they carry `id: 0`.
