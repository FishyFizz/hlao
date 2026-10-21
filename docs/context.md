# Standing context

The starting point for anyone — human or agent — picking this up cold. It records what
exists, what was decided, and where the edges are. `PRODUCT.md` is the thesis,
`STACK.md` the stack decision, `architecture.md` the seams, and `contracts/` the exact
surfaces. This file is the map between them and the code.

## State

- **Version:** 0.16.0, built 2026-10-21 on `dev`
  (provider session discovery and adoption; protocol 3.1 additive).
- **Status:** the primitive surface, supervisor, CLI, tests, the four acceptance
  assemblies, and the dashboard client are implemented and green. The socket is a public
  client contract: the bundled CLI, the dashboard, and an MCP server are interchangeable
  clients (ADR 0007). Every session in an HLAO instance is addressable by every caller;
  isolation is another instance. Provider-native state (compaction, plans, titles, agent
  identity, notices, and inter-session messages) is projected into `SessionView` and
  first-class events. Fleet observation (a merged live timeline, time/regex/context search,
  whole-instance export, usage aggregation, TTY-aware output) is a caller-owned projection,
  not supervisor state (ADR 0012). An agent's send to a busy peer is injected into the
  running turn when the adapter advertises ACP steering; otherwise it queues. The
  supervisor remains turn-serial: steering is a provider request, not a second local turn.
  HLAO owns no permission policy (ADR 0013): the provider mode is the coarse policy, every
  provider ask is relayed to the operator through a bounded FIFO, and a one-shot timeout
  fails closed. `permit` and any mode set (`mode`, `option <id> mode …`, `spawn --mode`,
  or a spawn `--config` mode option) are operator-only. Provider
  session discovery is a capability-gated read of ACP `session/list` (`backends.sessions`),
  live-joined to the supervisor table; `hlao adopt` loads one as a new HLAO session. There
  is no live provider-to-agent registry (ADR 0014). An append-only spawn-receipt ledger
  pairs parent and child provider ids for manual recovery after a restart; it is history,
  not liveness, and `hlao children` reads it (ADR 0015). A resumed or forked session keeps
  the provider's mode; `defaultMode` applies to new sessions only.
- **Verification:** `npm test` runs 284 tests: 282 pass, 2 skipped (POSIX-only process-group
  tests on Windows), 0 fail. The suite drives the real CLI and supervisor against a scripted
  ACP agent, including the acceptance assemblies, provider discovery/adoption, the
  post-reboot receipt recovery, and a raw-NDJSON conformance test that never invokes the CLI.
  The dashboard typechecks, passes 38 tests, and builds against wire 3.1.
- **Next:** N-08 containment (a scoped credential or separate instance), N-11's general
  resource bounds, and the remaining provider continuity hardening (RF-01, RF-02, RF-03,
  RF-06, RF-07, RF-08) remain. The dashboard wire-readiness assessment is
  `docs/protocol-stability.md`.
- **Real Claude verified on this machine (2026-10-19):** the bundled `claude` adapter
  completed a prompt, ran a shell tool, parked on a permission request that surfaced through
  `wait --until permission`, resumed after `hlao permit`, and — from inside its own shell —
  ran `hlao whoami` and `hlao list` using the injected `HLAO_CLI`/`HLAO_HOME`, seeing itself
  as `role: session`. This is the end-to-end proof that identity reaches a real leaf.
  The same run exposed the defect that led to 0.15: the adapter's Manual mode asks before
  every Bash call, and an HLAO `allow` default only hid the duplication. 0.15 removes the
  second policy: the provider mode (per-backend `defaultMode`, operator `--mode`) is the
  coarse policy, and every ask is relayed to the operator through `hlao permit`.
- **Codex:** the adapter starts and reaches its provider; the local account's provider
  returned `403 GROUP_NOT_ALLOWED`, so no successful Codex turn is claimed. That is provider
  configuration, not an HLAO failure.
- **OpenCode verified on this machine (2026-10-21):** the builtin `opencode` backend
  (`opencode acp`, OpenCode 2.1.0) completed a prompt, ran the `read` and `shell` tools,
  reported usage, and appeared in `provider sessions` as loadable/forkable with a live
  HLAO attachment. On Windows the executable is reached through the npm shim's wrapped
  `opencode.exe`, since the shim itself cannot be spawned. OpenCode exposes model and
  effort config options but no ACP modes (`modes: null`), so there is no mode to relay;
  its background `serve --service` daemon is provider-internal and outlives the ACP
  adapter, which HLAO does kill with the session.

## What the product is

A small set of plain operations both a human and an agent use:

- `spawn` — open a session, inject identity, optionally send the first message.
- `send` — queue a prompt; one turn at a time.
- `read` — orchestration state plus a bounded, cursor-addressed event page.
- `wait` — one-shot await on idle, permission, exit, or change.
- `list` — every session in this HLAO instance; there is no per-session scope.
- `cancel` / `close` / `permit` — the lifecycle operations around the five observables.
- `provider sessions` / `adopt` — a read of the provider's own catalog and a client
  assembly that loads one as a new HLAO session. Neither is a registry.
- `children` — read historical spawn receipts by parent provider id, including offline;
  the post-reboot recovery path, not a liveness query.

There is no scheduler. Recurring work is a loop the caller writes, using a bounded wait's
timeout as the timer. There is no shared-state object. Shared state is a file named by path
and announced by reference; the examples show it.

## Invariants to preserve

1. **No durable orchestration store.** The supervisor's live session table is the truth.
   The lock file is discovery only; the event log is bounded memory; the supervisor log is
   diagnostics. Provider session discovery is a read of the provider's catalog, joined to
   the live table, never a persisted HLAO registry. The spawn-receipt ledger is
   append-only history for manual recovery and is never read as liveness.
2. **`wait` never re-arms.** No recurring timers anywhere in `src/`.
3. **Reads are bounded and cursor-addressed.** Eviction is reported through `truncated` and
   `earliestRetainedSeq`.
4. **Identity is generated before the adapter process starts** and placed in its
   environment. The ACP session id is the durable provider handle, exposed as
   `SessionView.agentSessionId`; the HLAO id remains the supervisor-lifetime alias.
5. **One adapter process per session.** A crash, permission block, or close touches one
   session.
6. **One HLAO instance is one address space.** Every session in it is addressable by every
   caller. Isolation is another `HLAO_HOME`, socket, and token. `callerSessionId` is
   attribution, not scope; lineage is context, not authority (ADR 0008).
7. **Do not advertise `clientCapabilities.subagents`, `fs`, or `terminal`.** Provider
   subagents stay inside the leaf; HLAO does not become a filesystem or terminal provider.
8. **A refactor never changes behavior in the same commit.**

## Where things live

| Need to change… | Go to |
|---|---|
| a CLI command or flag | `src/cli/main.ts` and the matching `src/cli/commands/*.ts` |
| human/JSON rendering | `src/cli/render.ts` (barrel) and `src/cli/render/*` |
| a formatter or table rule | `src/cli/render/{text,table,session-table,entities,events,session}.ts` |
| the wire schema | `src/protocol/{views,methods}.ts`, `contracts/protocol.md` |
| boundary validation for a method | `src/protocol/parse/{session,system,common}.ts` |
| ACP handshake, prompt queue, cancellation | `src/session.ts`, `contracts/session.md` |
| permission/elicitation queue and deadline | `src/session/pending-input.ts` |
| provider-state projection (plan, compaction, title) | `src/session/provider-state.ts` |
| read context pages, wait conditions | `src/session/read.ts`, `src/session/waits.ts` |
| supervisor lifecycle, addressing, dispatch | `src/supervisor.ts` |
| persistent streams and subscriptions | `src/supervisor/connections.ts` |
| spawn/resume/fork and its retry window | `src/supervisor/spawn.ts` |
| backends/provider-catalog/receipt reads | `src/supervisor/discovery.ts` |
| wait-cycle detection and multi-session waits | `src/supervisor/{wait-graph,waits}.ts` |
| provider catalog probe (`backends.sessions`) | `src/provider.ts` |
| provider discovery/adoption commands | `src/cli/commands/provider.ts`, `src/cli/commands/adopt.ts` |
| spawn receipts and their read surface | `src/ledger.ts`, `src/cli/commands/children.ts` |
| autostart, lock probing, request transport | `src/client.ts`, `src/client/*`, `src/lock.ts` |
| backend manifests, config merge, command resolution | `src/config.ts`, `src/config/backends.ts`, `contracts/backends.md` |
| retention / cursor / eviction rules | `src/events.ts`, ADR 0002 |
| timeouts, ids, errors, paths | the matching leaf module in `src/` |
| acceptance assemblies | `examples/acceptance/` |
| the test agent's behavior | `tests/fixtures/fake-acp-agent.ts` |

## How to run and verify

```bash
npm run check                 # strict tsc, sources and tests
npm test                      # everything
npm run test:unit
npm run test:e2e
node dist/cli.js doctor       # after npm run build
```

The e2e harness gives each test its own `HLAO_HOME` in a temp directory: its own supervisor,
named pipe, config, and fake backend. Cleanup ends the supervisor and removes the home.

To exercise a real provider:

```bash
hlao doctor
hlao agents
hlao spawn claude "Reply with exactly: hello" --wait
hlao read <id> --since 0
hlao provider sessions claude --cwd "$PWD"
hlao adopt claude <provider-id> --cwd "$PWD"
hlao close <id>
hlao down
```

## Design decisions already made

- Persistent per-user supervisor instead of re-attach per CLI call: ADR 0001.
- Bounded in-memory event log instead of a durable transcript: ADR 0002.
- Provider history is read, never authored. The provider session id is the durable handle;
  `spawn --resume` reopens it with ACP `session/load`, and `spawn --fork` copies it with
  `session/fork`: ADR 0011.
- Provider session discovery is a capability-gated read of ACP `session/list`, joined to
  the live table; adoption is a client assembly, not a stored mapping: ADR 0014.
- Spawn receipts are historical, keyed by the parent provider id, and never liveness:
  ADR 0015.
- Identity generated before process start; ACP ids internal: ADR 0003.
- Permission requests are orchestration state; the provider owns the policy, every ask is
  relayed to the operator, and control is operator-only: ADR 0013 (superseding the policy
  mechanism in ADR 0004).
- One serialized turn; cancel clears the queue: ADR 0005.

## Deliberately absent

No scheduler, DAG, workflow engine, global registry, SQLite/NATS, task table, HTTP API,
MCP-only surface, provider subagent surfacing, client fs/terminal capabilities, cold-host
lineage reconstruction, or durable event store. Each absence is a constraint from
`PRODUCT.md`, not an unfinished feature. Provider history is not absent: it lives in the
provider, and `spawn --resume` reads it through ACP `session/load` (ADR 0011). Provider
discovery is not a registry: `backends.sessions` reads the provider's catalog and joins the
live table (ADR 0014). Tree recovery is not automatic: the spawn-receipt ledger lets a
resumed leader adopt children by provider id one at a time (ADR 0015), but HLAO ids and
lineage are not restored.

## Known limitations and edges

- **Hard-killing the supervisor can orphan adapter processes**, especially on Windows. Use
  `hlao down` for the graceful path. The supervisor sends `session/close`, then SIGTERM,
  then SIGKILL.
- **A supervisor crash loses all sessions and history.** Accepted by the design.
- **One supervisor per `HLAO_HOME`.** Two homes mean two independent supervisors and pipes.
- **Closed sessions are retained in memory for one hour** (`retainClosedMs`) so their output
  can still be read; they are not persisted. Retention is enforced lazily on the next
  request, so the supervisor owns no recurring housekeeping timer.
- **A very large single event is previewed**, marked `rawTruncated`, rather than allowed to
  evict the rest of the log.
- **The instance is the coordination boundary, not a security boundary.** A process that
  strips its environment can act as the operator. Inside an instance, any caller can address
  any session; isolation is another instance.
- **Provider sessions can be driven from outside the instance.** HLAO cannot detect another
  client or another HLAO home holding the same provider session. `hlao adopt --fork` is the
  safe option when the source must stay untouched; there is no cross-instance lease.
- **ACP v1 is the only transport.** The optional `node-pty` fallback in `STACK.md` is not
  implemented in 0.1.0 and is not installed. A backend without an ACP adapter cannot be
  driven yet.

## Open product questions (still open)

From `PRODUCT.md`, these are product decisions, not engineering gaps:

- Q3: frequency and cost of the failure this removes.
- Q4: the ratchet policy — who may re-plan and who may halt, beyond the available
  `cancel`/`close`.
- Q5: whether this is for anyone but the author.
- Q7: whether announcing by reference is the default or always required.
- Q8: who holds write authority over a ledger (orchestrator-only, discoverer-writes, or
  append-only corrections).

The primitives support each answer; the answer is a convention the operator chooses, and
`examples/acceptance/` shows the append-only style.
