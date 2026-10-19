# ADR 0007 — The socket protocol is the client boundary

**Status:** accepted, 2026-10-20 (milestone 0.4).

## Context

The CLI and the supervisor grew together in one codebase. `contracts/protocol.md` described the
wire as an internal seam: "Both sides are HLAO code; there is no third party." That was true
while the CLI was the only client, but it conflates two different things: the orchestration
core and the way a person looks at it.

The product needs a human surface richer than a command line — a dashboard or TUI — and agents
need a tool-native surface such as MCP. If either surface is allowed to shape core semantics,
the design acquires a second authority, which is the failure class HLAO exists to remove.
Presentation changes constantly; session state and authority must not.

## Decision

- The supervisor's NDJSON socket protocol is the product boundary. Core owns session state,
  ACP, the event log, scope, and the wire methods. It owns no rendering, keybindings, flags, or
  polling cadence.
- Every client — the bundled CLI, a future TUI or web dashboard, an MCP server — uses only the
  socket. A client that needs a capability the wire lacks must extend the wire deliberately.
- The bundled CLI remains in the tree as the reference client and the agent-facing surface. It
  may add client-only sugar (`--jsonl`, human rendering, a local `agents` command) as long as
  every orchestration capability it uses is reachable by another client.
- The protocol version is `major.minor`. A breaking change bumps major; an additive change
  bumps minor. Clients require major equality and feature-detect optional behavior through
  `hello.capabilities`.
- Polling `sessions.list` and `sessions.read` is the supported live-update model. A push
  subscription is a protocol change, not a client trick.

## Alternatives rejected

- **Put the TUI in core.** It would make layout and terminal behavior part of the product's
  semantics, and every UI change would risk the orchestration surface.
- **Let clients read config files or the event log directly.** That duplicates config merging
  and makes the filesystem a second authority. `backends.list` exists so clients do not.
- **A separate "dashboard protocol".** A second protocol is a second authority. One wire, many
  clients.
- **Version by package version only.** A client must be able to decide compatibility without
  knowing the package's release history. `major.minor` plus capabilities is explicit.

## Consequences

- `contracts/protocol.md` becomes a public client contract, not an internal note.
- The core gains `backends.list`, usage in `SessionView`, read filters/paging, and multi-id
  `wait`; these are capabilities any client may use.
- Client-only conveniences (`--quiet`, `@last`, `cancel --wait`, `permit --all-pending`,
  `send --tree`) stay out of the wire and are built by looping over methods.
- A future dashboard is a separate package. It can be replaced without touching core, and a
  conformance test proves it needs no private access.
- The supervisor still owns no recurring timer; a client's refresh loop is the client's.
