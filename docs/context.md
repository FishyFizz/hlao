# Standing context

The starting point for anyone — human or agent — picking this up cold. It records what
exists, what was decided, and where the edges are. `PRODUCT.md` is the thesis,
`STACK.md` the stack decision, `architecture.md` the seams, and `contracts/` the exact
surfaces. This file is the map between them and the code.

## State

- **Version:** 0.4.0, built 2026-10-20 on `milestone/0.4-socket-contract`
  (socket protocol as the client boundary; observation completeness).
- **Status:** the primitive surface, supervisor, CLI, tests, and the four acceptance
  assemblies are implemented and green. The socket is a public client contract: the bundled
  CLI, a future dashboard/TUI, and an MCP server are interchangeable clients (ADR 0007).
- **Verification:** `npm test` runs 133 tests: 54 unit and 79 end-to-end through the real CLI
  and supervisor against a scripted ACP agent, including the five acceptance-assembly tests
  and a raw-NDJSON conformance test that never invokes the CLI.
- **Real Claude verified on this machine (2026-10-19):** the bundled `claude` adapter
  completed a prompt, ran a shell tool, parked on a permission request that surfaced through
  `wait --until permission`, resumed after `hlao permit`, and — from inside its own shell —
  ran `hlao whoami` and `hlao list` using the injected `HLAO_CLI`/`HLAO_HOME`, seeing itself
  as `role: session`. This is the end-to-end proof that identity reaches a real leaf.
  The same run exposed a default-policy defect: the adapter's Manual mode asks before every
  Bash call, so `ask` as the default parked the agent on each tool. The default is now
  `allow`, `ask` is opt-in, `permit --always` removes the gate from a live session, and
  provider modes are exposed through `--mode` / `hlao mode`.
- **Codex:** the adapter starts and reaches its provider; the local account's provider
  returned `403 GROUP_NOT_ALLOWED`, so no successful Codex turn is claimed. That is provider
  configuration, not an HLAO failure.

## What the product is

A small set of plain operations both a human and an agent use:

- `spawn` — open a session, inject identity, optionally send the first message.
- `send` — queue a prompt; one turn at a time.
- `read` — orchestration state plus a bounded, cursor-addressed event page.
- `wait` — one-shot await on idle, permission, exit, or change.
- `list` — sessions in the caller's scope (operator: all; agent: self and descendants).
- `cancel` / `close` / `permit` — the lifecycle operations around the five observables.

There is no scheduler. Recurring work is a loop the caller writes, using a bounded wait's
timeout as the timer. There is no shared-state object. Shared state is a file named by path
and announced by reference; the examples show it.

## Invariants to preserve

1. **No durable orchestration store.** The supervisor's live session table is the truth.
   The lock file is discovery only; the event log is bounded memory; the supervisor log is
   diagnostics.
2. **`wait` never re-arms.** No recurring timers anywhere in `src/`.
3. **Reads are bounded and cursor-addressed.** Eviction is reported through `truncated` and
   `earliestRetainedSeq`.
4. **Identity is generated before the adapter process starts** and placed in its
   environment. ACP session ids stay internal.
5. **One adapter process per session.** A crash, permission block, or close touches one
   session.
6. **Self-and-descendants scope is enforced in the supervisor**, not in the CLI.
7. **Do not advertise `clientCapabilities.subagents`, `fs`, or `terminal`.** Provider
   subagents stay inside the leaf; HLAO does not become a filesystem or terminal provider.
8. **A refactor never changes behavior in the same commit.**

## Where things live

| Need to change… | Go to |
|---|---|
| a CLI command, flag, or human rendering | `src/cli/main.ts`, `src/cli/render.ts` |
| the wire schema or validation | `src/protocol.ts`, `contracts/protocol.md` |
| ACP handshake, prompt queue, permissions, cancellation | `src/session.ts`, `contracts/session.md` |
| supervisor lifecycle, scope enforcement, dispatch | `src/supervisor.ts` |
| autostart, lock probing, request transport | `src/client.ts`, `src/lock.ts` |
| backend manifests and config merge | `src/config.ts`, `contracts/backends.md` |
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
hlao close <id>
hlao down
```

## Design decisions already made

- Persistent per-user supervisor instead of re-attach per CLI call: ADR 0001.
- Bounded in-memory event log instead of a durable transcript: ADR 0002.
- Identity generated before process start; ACP ids internal: ADR 0003.
- Permission requests are orchestration state; the default policy is `allow`, with `ask`
  opt-in, `permit --always` for a live session, and provider modes exposed: ADR 0004.
- One serialized turn; cancel clears the queue: ADR 0005.

## Deliberately absent

No scheduler, DAG, workflow engine, global registry, SQLite/NATS, task table, HTTP API,
MCP-only surface, provider subagent surfacing, client fs/terminal capabilities, cold-host
lineage reconstruction, or durable event store. Each absence is a constraint from
`PRODUCT.md`, not an unfinished feature.

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
- **The scope rule is coordination, not security.** A process that strips its environment
  can act as the operator.
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
