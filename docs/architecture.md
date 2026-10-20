# Architecture

> HLAO is a primitive surface, not a framework. This document fixes the module map, the
> direction of every dependency edge, and the handful of invariants that make the surface
> honest. The contracts next door are the authority on public surfaces; this file is the
> authority on how the pieces fit.

## The goal this serves

From `PRODUCT.md`: nothing about an agent-run job is decided before the job is understood.
The operator and the agent drive the same small set of plain operations; the agent sees the
situation and has the authority to act on it. The architecture exists to keep that true —
which means no frozen decisions hiding in a store, a schema, or a daemon's private state.

## Runtime shape

```
 human                   agent
   │                       │
 dashboard / TUI        CLI / MCP
   └──────────┬────────────┘
              │  framed JSON over a pluggable stream (the client contract)
              │  named pipe / Unix socket today; TCP and other adapters are additions
              ▼
   supervisor (one per HLAO_HOME, detached)
              │  ACP v1 over stdio, one adapter process per session
              ▼
   provider adapter ──► provider runtime ──► leaf tools
```

- The socket protocol is the product boundary (ADR 0007). The bundled CLI is the reference
  client; a dashboard, TUI, or MCP server is another client and must not need private access.
  If a client needs a capability the wire lacks, the wire is extended deliberately.
- The CLI is a thin request/response client. It holds no orchestration state. Its only loops
  are caller-owned watches (`read --follow` over read + one-shot wait, and `logs --follow` over
  the supervisor's file), which end with the CLI process.
- The supervisor owns live sessions and their child processes. Its in-memory process table
  is the state; there is no session database and no global session registry.
- Each HLAO session is one adapter process running one ACP session. Isolation is deliberate:
  a crash, a permission block, or a close touches one session.
- On a graceful exit the supervisor closes its sessions. If it is killed hard, the session
  table is gone and adapter processes can be orphaned (especially on Windows); use
  `hlao down` for the supported shutdown path. Either way there is no durable orchestration
  store to recover from (`PRODUCT.md`, "Where state lives"). The operator's user-space files
  (ledger, contact list) are the only durable artifacts.

## Module map

| Module | One responsibility | Owns | Depends on |
|---|---|---|---|
| `errors` | Typed failures with stable codes | error taxonomy | — |
| `time` | Duration parsing/formatting | — | — |
| `ids` | Session handle generation/validation | — | — |
| `version` | Package version at runtime | — | — |
| `paths` | Runtime file and socket locations | location naming | `errors` |
| `protocol` | Client↔supervisor wire contract and boundary validation | wire schema, version, capabilities | `errors` |
| `stream` | Framed message streams over a transport | framing, buffering, transport adapters | `protocol`, `errors` |
| `lock` | Lock file read/write, pid liveness, liveness probe | discovery semantics | `paths`, `protocol`, `stream`, `errors` |
| `logger` | Supervisor diagnostics log | log rotation | `paths` |
| `config` | Backend manifests and user/project config | config merge rules | `paths`, `errors` |
| `events` | Bounded, seq-addressed event log | retention and cursors | — |
| `session` | One ACP-backed session: process, handshake, prompt queue, permissions, waits | session state machine | `protocol`, `events`, `config`, `errors`, `ids`, `time`, `version` |
| `supervisor` | Process lifecycle, lock/listener, dispatch, universal addressing | live session table | `session`, `config`, `lock`, `logger`, `paths`, `protocol`, `stream`, `errors` |
| `client` | Client-side transport and autostart | — | `lock`, `protocol`, `paths`, `stream`, `errors` |
| `cli` | Bundled reference client: argument parsing and human/JSON rendering | presentation only | `client`, `config`, `lock`, `protocol`, `paths`, `errors`, `time`, `version`, `supervisor` (the hidden `__supervisor` entry) |

Three modules have focused submodules. `protocol.ts` is a barrel over `protocol/version.ts`
(wire constants and capabilities), `protocol/contract.ts` (types and method names), and
`protocol/parse.ts` (boundary validation). `session.ts` keeps the `Session` state machine;
`session/{queue,async,process,permissions,projection}.ts` hold its pure helpers.
`supervisor.ts` keeps the server; `supervisor/{util,resolve}.ts` hold helpers and token
resolution. Submodules never import their own barrel.

The CLI is split by responsibility: `main.ts` dispatches and owns global exits; `context.ts`
resolves the runtime home, caller identity, and targets, and formats errors; `args.ts` and
`input.ts` parse flags and messages; `help.ts` holds the help text; `render.ts` renders tables
and events; and `commands/` has one module per command. `commands/session-view.ts` holds the
shared display/terminal/resolve projections and `commands/prompt-support.ts` the bounded
partial-output helper. `commands/{control,prompts,ops}.ts` remain as barrels for stable
imports. No command module owns orchestration state.

Edges point one way. `session` does not import `supervisor`; `client` does not import
`session`; no core module imports `src/cli/*` (guarded by a unit test). A module's public
surface is enumerated in `contracts/`.

Presentation clients live outside that dependency graph. The bundle ships the CLI; a future
dashboard or TUI is a separate package that speaks the socket and can be replaced without
touching core.

## The identity chicken-and-egg, and its answer

HLAO session identity must exist in the child's environment *before the child process
starts*, so that every leaf tool it runs can see it. ACP assigns its own session id only
after `session/new`, which is too late.

Answer: HLAO generates its own 6-character handle first, injects it into the adapter
process environment, and keeps the ACP `sessionId` private to the supervisor. The two
identifiers never need to be equal, and ACP ids are never exposed as operator handles.

Injected at spawn:

| Variable | Meaning |
|---|---|
| `HLAO_SESSION_ID` | this session's handle |
| `HLAO_PARENT_ID` | the handle that spawned it (absent at the root) |
| `HLAO_ROOT_ID` | the job root's handle |
| `HLAO_DEPTH` | 0 at the root |
| `HLAO_BACKEND` | backend manifest name |
| `HLAO_HOME` | runtime home, for endpoint discovery |
| `HLAO_CLI` | absolute path to the CLI entry point |

The parent's knowledge of its children is the handles it holds, but that is lineage context,
not a visibility scope: every session in an instance is addressable by every caller (ADR 0008).
The supervisor keeps the live parent links for lineage and `--tree`; it never writes a tree to
disk and never reconstructs one after a restart.

## Read projection

Two kinds of information, deliberately separated:

1. **Orchestration state** — status, turn count, queue depth, pending permission, last
   sequence, process state, lineage. This is what makes a stuck job visible.
2. **Leaf events** — message chunks, thoughts, tool calls, plans, notices. This is what the
   agent said or did, which is the leaf's business.

`read` returns orchestration state plus a bounded page of typed events. `read --raw`
includes the original ACP update payloads. A read is always cursor-addressed or a tail
window — never an unbounded dump:

- `read` with no cursor returns the most recent `limit` events.
- `read --since N` returns events with `seq > N`, up to `limit`.
- The response always reports `earliestRetainedSeq`, `lastSeq`, and `hasMore`.
- If `since` precedes the oldest retained event, `truncated` is `true`. Silence about lost
  events would be a lie the operator cannot see.

Retention is bounded by both event count and approximate bytes. One oversized update is
previewed and flagged rather than allowed to evict the whole log. A read page is also
bounded by bytes as well as count, so a page of 1000 maximally-sized events cannot become a
100 MB response; fewer events are returned with `hasMore: true`.

### Checking the projection against the cron episode

The cron failure had two frozen decisions: a fired session could not manage its own job, and
the primitive could not express "stop when". In HLAO:

- A session's own handle is always addressable, so `hlao cancel $HLAO_SESSION_ID` and `close`
  work from inside it. A participant that can see its situation is never locked out of managing
  it.
- Nothing fires. Recurrence exists only while a caller keeps issuing one-shot waits; when
  the caller stops, the leak stops.
- The termination condition is never claimed by the primitive. The caller reads the leaf's
  text and decides. The log says what happened, not whether the world is done.

The projection reports exactly the facts that make the frozen case visible: whose turn is
active, whether a permission blocks it, how many messages are queued, and whether the
session is still alive.

## Wait semantics

`wait` is a one-shot await on orchestration state: `idle`, `permission`, `exit`, or
`change`. A timeout is a bound on the await, not a schedule. When it fires, the wait returns
`reason: "timeout"` and the session keeps running. Nothing in the design re-arms a timer.

This is the property that keeps cron out: recurrence can only be assembled by an agent or
operator that observes a result and chooses to wait again. The timer is the timeout; the
judgement is outside the primitive.

## Prompt queue

A session runs at most one ACP prompt turn at a time. `send` while busy enqueues; the queue
depth is part of the visible orchestration state. `cancel` stops the active turn *and*
discards queued prompts, because a stop request that immediately starts the next queued
message is not a stop. Discarded prompts settle as `cancelled`, and the event log records
each discard.

`send --wait` waits for the turn produced by *that* message. A timeout does not cancel the
turn; it returns `timedOut: true` and leaves the work running.

## Permissions

Permission requests are orchestration state, not a hidden callback. The default policy
`allow` answers with the first allow option and records the answer (`by: policy:allow`), so a
session does not park on its first tool call. `ask` (opt-in) stores the request, exposes it
through `read` and `wait --until permission`, and blocks the ACP turn until the operator (or
the agent, via `hlao permit`) answers. `deny` answers with a reject option. Every answer is
recorded with who chose it and which option.

`hlao permit <id> --allow --always` switches a live session's policy to `allow` and prefers
the provider's `allow_always` option when offered. Provider-native modes are a second layer:
the session view reports the adapter's `modes`, `spawn --mode` selects one, and `hlao mode`
reads or switches it. The provider can therefore stop asking at the source while HLAO keeps
the guarantee that a request cannot silently hang.

## Addressing and isolation

- **One instance is one address space.** `HLAO_HOME`, the supervisor, the socket, and the token
  define a single HLAO instance. Every session in it is addressable by every caller.
- An operator shell has no `HLAO_SESSION_ID`; an agent shell inherits one for attribution and
  self-defaulting. Neither is a visibility filter.
- `callerSessionId` is recorded as `by` on mutating events. It grants nothing and forbids
  nothing (ADR 0008).
- `parentId`, `rootId`, and `depth` are lineage and context. They do not decide who may read,
  wait on, stop, or resume a session.
- Isolation is another instance: a different `HLAO_HOME`, socket, and token. There is no
  cross-instance visibility or addressing.
- This is a coordination boundary, not a security boundary. A process that deliberately
  strips its environment can act as the operator. `PRODUCT.md` states the same: coordination
  is a trust protocol. Any caller in an instance can interfere with any session, exactly as a
  human with the harness can; attribution makes it visible, and conventions prevent it.

## Failure behavior

| Failure | Result |
|---|---|
| Adapter fails to start or handshake | `spawn` fails with the adapter's stderr tail; no half session is listed |
| Adapter exits mid-turn | session becomes `failed`; active and queued prompts settle as failed; `wait` returns |
| Adapter ignores `session/cancel` | session stays `busy`; `close --force` is the hard halt |
| Client disconnects during `wait`/`send --wait` | the waiter is removed; the session is unaffected |
| Supervisor exits gracefully | all child sessions end; lock and socket are removed |
| Supervisor is killed hard | the session table is gone; adapter processes can survive on Windows; `down --force` removes an unverified stale lock without killing its pid |
| Stale lock after a crash | next command detects a dead pid, removes the lock, autostarts |
| Event log evicts unread events | `read` reports `truncated: true` and the earliest retained sequence |

## What is deliberately absent

- No job object, workflow graph, scheduler, DAG, task table, or global registry.
- No durable event store or transcript authority.
- No cold-host lineage reconstruction; the tree is the live handles.
- No provider-internal subagent surfacing: `clientCapabilities.subagents` is never
  advertised, so provider subagents stay inside the leaf.
- No client-side filesystem or terminal capabilities: the adapter's own leaf tools remain
  the only leaf authority.
- No MCP-only surface, no daemon HTTP API, no multi-user server.

## Decided in ADRs

- `0001-supervisor-per-user.md` — persistent supervisor instead of re-attach per call.
- `0002-cursor-bounded-event-log.md` — the read projection and its retention rules.
- `0003-lineage-at-spawn.md` — identity is generated before process start and injected.
- `0004-permissions-are-orchestration-state.md` — ask/allow/deny and `permit`.
- `0005-prompt-queue-and-cancel.md` — serialized turns; cancel clears the queue.
