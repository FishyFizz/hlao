# ADR 0001 — A persistent per-user supervisor

**Status:** accepted, 2026-10-19.

## Context

ACP v1 speaks JSON-RPC over the adapter process's stdio. The connection dies with the
client process. HLAO's primitives include `wait` and `send --wait`, and a session must
survive across separate CLI invocations; a job that is running when the terminal closes
must still be observable.

`STACK.md` names exactly two viable shapes and requires the choice before code:

1. a persistent supervisor that owns adapter processes and serves CLI calls over IPC;
2. re-attach on every call via `session/load` / `session/resume`.

## Decision

One detached supervisor per `HLAO_HOME`, discovered through
`<HLAO_HOME>/supervisor.json` and reachable over a per-user named pipe (Windows) or Unix
socket. It owns adapter child processes; the CLI is stateless and opens one request
connection per command.

Sessions do not survive supervisor death. That is accepted: the design has no durable
orchestration store, and a restart that reconstructed sessions would be the registry
`PRODUCT.md` excludes.

## Alternatives rejected

- **Re-attach per call.** Every command would pay adapter startup, and in-flight turns
  could not be observed between calls. `send --no-wait` would have no owner. `session/load`
  is agent-specific and may replay history or require provider support; `wait` would have
  nothing to wait on. This shape cannot express the primitives, not merely an inferior one.
- **`acpx` as the runtime.** Pre-1.0, and it owns session records under `~/.acpx` keyed by
  command/cwd/name with TTL auto-resume. That store would become a second authority over
  which sessions exist (`STACK.md`).
- **A daemon HTTP server.** Larger surface, port allocation, and an API that invites
  clients; a local socket with a token is the smallest thing that works. HTTP adds nothing
  the CLI needs.

## Consequences

- The supervisor is a process with a lifecycle: lock file, stale-lock recovery, graceful
  shutdown, and diagnostics. That is real cost, accepted for observable sessions.
- Operator-visible state is in the supervisor's live process table, reachable through
  `list`/`read`. Nothing is written to a database.
- If the supervisor crashes, sessions end. The operator's user-space files remain.
- One supervisor serves all project directories for the user; per-session `cwd` is stored
  on the session, and project backend config is read per spawn.
