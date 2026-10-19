# ADR 0003 — Identity is generated before the process starts and injected

**Status:** accepted, 2026-10-19.

## Context

`PRODUCT.md` requires that a participant knows who spawned it from birth, and `STACK.md`
requires identity to be injected into the child's environment rather than stored. ACP,
however, assigns its session id in the `session/new` response — after the adapter process
has already started. Environment variables cannot be added to a running process.

## Decision

HLAO generates its own 6-character session handle before spawning the adapter. That handle,
the parent, the root, and the depth are placed in the adapter's environment. The ACP session
id returned by `session/new` is stored only in the supervisor and exposed as
`agentSessionId` for diagnostics.

One adapter process hosts exactly one ACP session. This makes the environment unambiguous:
there is no moment where two sessions share a process and therefore share identity.

## Alternatives rejected

- **Use the ACP id as the handle.** Impossible to inject before start; would also leak a
  provider-assigned identifier into the operator surface and couple handle stability to the
  adapter.
- **Send identity in the first prompt.** That is a message, not an environment; a leaf shell
  command run before reading the prompt would not see it. `CLAUDE.md`-style injection works
  because the harness injects it, not because the agent is told to remember.
- **One adapter process with many sessions and per-session env.** Node cannot vary the
  environment of a subprocess per ACP session inside one process without adapter support
  that does not exist. Rejected as unimplementable across providers.
- **A lineage file written on spawn.** `STACK.md` excludes it: it is an object that must be
  kept true, and nothing in the design needs cold-host reconstruction.

## Consequences

- Handles are short, stable for the session's life, and operator-friendly.
- Spawning costs one adapter process per session. Accepted for isolation and unambiguous
  identity.
- The parent→child relation exists in supervisor memory only. On supervisor death, the tree
  is gone — the documented behavior.
- A session handle is not a security credential. Any process with `HLAO_HOME` and the lock
  token can drive the supervisor; coordination is a trust protocol.
