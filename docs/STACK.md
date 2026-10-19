# STACK.md — HLAO

> HLAO is a primitive surface for agent orchestration: a small set of plain operations (open a
> session, send, read, wait, list) that a human operator and an agent drive through the same
> commands, with no hidden orchestration store. This document decides the language and libraries
> only. It does not define the primitives, the session table, or the supervisor lifetime — those
> belong to the architecture stage.
>
> **Verified against registries and upstream docs on 2026-10-19.**

## Decision

**TypeScript on Node ≥ 22.13** — chosen because the load-bearing capability is a
provider-agnostic, long-lived, structured agent-session substrate, and **ACP (Agent Client
Protocol)** is the only stable wire-level abstraction with first-party adapters for the backends
that matter.

| Layer | Library | Version | Why this one |
|---|---|---|---|
| Runtime / substrate | Node.js + built-in `child_process` | Node ≥ 22.13 (local: 26.8.1) | Pure-TS protocol client, no native build deps, first-class on Windows 11 |
| Protocol / client | `@agentclientprotocol/sdk` | `1.9.0` (pin exact) | ACP v1 stable; complete session lifecycle; Apache-2.0; 4.56M weekly downloads |
| Adapter — Claude Code | `@agentclientprotocol/claude-agent-acp` | `0.93.0` (pin exact) | ACP-org adapter wrapping the Claude Agent SDK; supports list/load/resume |
| Adapter — Codex | `@agentclientprotocol/codex-acp` | `2.2.2` (pin exact) | ACP-org adapter; supports list/load/resume |
| Adapter — Gemini / Goose / OpenCode / custom | command manifest | per tool | ACP entry point per tool (e.g. `opencode acp`); any command is a backend |
| Core model | **own code** | — | No existing library provides self-and-descendants visibility without introducing a store or registry |
| Presentation | own CLI + `--json` (built-in `util.parseArgs`, or `commander` if a parser is wanted) | — | Human and agent use the same surface; MCP is an optional wrapper, never the only surface |
| Persistence | filesystem, flat JSON/JSONL via `node:fs` | — | Operator-readable; no database; not an authority |
| Optional PTY fallback | `node-pty` | `1.1.0` | Only for backends with no ACP; rendered output, explicitly lower fidelity |
| Tests | built-in `node:test` | — | Zero dependencies |

### Stack rules that follow from the decision

1. **The adapter is a data manifest, not a class.** A backend is `{ command, args, env }`.
   Adding one must not require writing adapter code.
2. **ACP v1 only.** Negotiate `protocolVersion: 1`. Do not ship against the draft v2.
3. **Do not advertise `clientCapabilities.subagents` by default.** Both the Claude and Codex
   adapters expose provider-internal subagents as ACP child sessions when the client declares
   this capability. Surfacing them would create a second session-birth mechanism alongside
   HLAO's own `spawn`. Provider subagents stay inside the leaf.
4. **Do not call `session/list` blindly.** Check `sessionCapabilities.list` in the `initialize`
   response first. Both chosen adapters advertise it.
5. **`read` is cursor-addressed and bounded.** ACP supplies a typed `session/update` stream;
   reads return events since a known sequence, never a full snapshot.
6. **Separate orchestration state from leaf output.** ACP events are world-facing
   (`agent_message_chunk`, `tool_call`, tool results). The orchestration projection reports
   turn state, pending prompts, pending permissions, and last sequence. Raw leaf output is a
   separate explicit read.
7. **Lineage is delivered at spawn, not stored.** ACP cannot reconstruct who spawned whom,
   and that is fine: the spawner injects the session, parent, and root identifiers into the
   child's environment. The child's knowledge of its parent is bounded and nameable from birth.
   A parent's knowledge of its descendants is the handles it holds — naming, not a registry.
   Any durable shared list (a contact list, a ledger) is a user-space file convention the
   agents maintain, not a HLAO entity.

### Lineage is delivered, not stored

The tempting move is a per-job lineage file. Do not add it. It is an object the design would
have to keep true, and none of the design's claims need it:

- **A child learns who spawned it at birth.** Identity is injected into its environment. That
  is bounded, nameable ignorance — which is the requirement.
- **A parent knows what it spawned because it holds the handles.** That is naming, the same way
  a human remembers which panes they opened.
- **A sibling or late joiner is reached by the spawner's joining facts**, or by whatever contact
  list the agents maintain. That list is a convention on the filesystem, not a primitive.
- **If the parent dies, the tree is gone.** That is not a regression: a mechanism to rebuild it
  would be a global registry, which the shallow-delegation scope explicitly excludes.

Consequence: no cold-host reconstruction requirement, and no lineage write on spawn beyond the
environment the spawn already injects.

## Why this over the runners-up

### `acpx` — the closest existing library, rejected as the core

`acpx` 0.19.6 (MIT, 2026-10-16, 338k weekly downloads) already provides a headless ACP client
with persistent sessions (`sessions new/list/ensure/close/show/history/watch`), prompt with
`--no-wait`, cancel, permission modes, NDJSON events, a per-session queue owner that survives
CLI invocations, and reconnect via `session/load` / `session/resume`. `createSharedAcpRuntime()`
makes it embeddable.

It is rejected as the architectural center for three reasons:

- It self-labels **pre-1.0**: “Treat its CLI and runtime interfaces as evolving.”
- It owns a session record store under `~/.acpx/sessions`, keyed by
  `(agentCommand, cwd, name)`, with auto-resume by directory walk and an idle TTL. Those are
  decisions frozen at authoring time, and they would become a second authority over “which
  sessions exist” — precisely the failure class HLAO exists to remove.
- Its defaults (default agent `codex`, scope key, TTL, queue semantics) leak into the surface.

**Retained use:** a 1–2 day spike to validate adapter authentication, event shapes, and Windows
behavior, and as a reference implementation. If the spike shows the semantics fit exactly, it may
return as a replaceable transport backend — never as the source of truth.

### Rust — rejected

The `agent-client-protocol` crate is the reference implementation and would give a single binary
with strong process supervision. It loses because the bottleneck here is design iteration, not
runtime performance, and the adapter commands it would spawn are the same external processes
either way.

### Python — rejected

An ACP Python SDK exists on PyPI (`agent-client-protocol`, asyncio transports and generated
schema models), but the first-party adapters and `acpx` are Node packages. A Python core would
still ship Node sidecars for Claude Code and Codex.

### Claude Agent SDK — rejected as the core

- Provider lock: using it as the substrate turns “generic adapter” into “Claude plus a
  translation layer.”
- License: `© Anthropic PBC. All rights reserved.` Use is governed by Anthropic's Commercial
  Terms of Service, not an open-source license.
- Still 0.x (`0.3.303`).
- It owns the agent loop and tool surface; it is the kind of harness with built-in primitives
  that HLAO replaces.

It is still used — behind ACP, through `@agentclientprotocol/claude-agent-acp`. Add a direct SDK
adapter only if a Claude-specific capability is needed that ACP does not expose.

### Agent frameworks — rejected

Mastra, Vercel AI SDK, OpenAI Agents SDK, and LangGraph all own the agent loop and/or state.
Building the orchestrator on them would reproduce frozen orchestration under a new name.

## Caveats of the chosen stack

- **`acpx` is pre-1.0** by its own README. This is why it is not the core.
- **Claude Agent SDK is proprietary** and is a transitive dependency of the Claude ACP adapter.
  Fine for a personal tool; re-evaluate before distributing.
- **ACP `systemPrompt` is an unstable extension.** The Claude adapter supports
  `append` / `override` on `session/new`, `load`, `resume`, and `fork`, but the portable way to
  deliver the joining ledger is the first prompt as a reference, not a system-prompt field.
- **Adapter versions move daily.** `@agentclientprotocol/claude-agent-acp` is 0.93.0 and
  `@agentclientprotocol/codex-acp` is 2.2.2; both published 2026-10-19. Pin exact versions and
  upgrade deliberately.
- **Windows 11.** The ACP SDK is pure TypeScript. `node-pty` is needed only for the fallback and
  ships prebuilt win32 x64/arm64 binaries, but remains a native addon. `agent-backbone` is
  POSIX-only and was ruled out; `ravi` requires Bun.
- **stdio transport lifetime.** In ACP v1 the connection lives with the client process. If
  sessions must outlive a CLI invocation, only two shapes work: a persistent queue owner /
  supervisor (the `acpx` / tmux-server model), or re-attach on every call via
  `session/load` / `session/resume`. This must be decided in architecture before any code.
- **ACP v2 is a draft.** The stable wire version is `1`.
- **`session/list` is capability-gated and agent-scoped.** It does not provide global
  visibility; self-and-descendants must be enforced by the injected identity and held handles,
  not by asking the protocol for a global list.
- **License check:** every proposed core dependency is Apache-2.0 or MIT. No copyleft. The one
  exception is the proprietary Claude Agent SDK behind the Claude adapter.

## Prior art

| Project | Stack | What it does | Our delta |
|---|---|---|---|
| `acpx` | TS / Node | Headless ACP client with persistent sessions, queue owner, NDJSON events | We own the semantics; its scope key, TTL, and session store are excluded |
| Claude Agent SDK / Claude Code | TS / Python | Agent runtime with sessions, subagents, hooks, custom tools | Provider-only; owns the loop; retained behind ACP |
| `pi-durable-subagents` | TS / Pi | `agent_spawn` / `message` / `wait` / `observe` / `control`, durable children, obligations | Pi-only; adds Owner/Spawner/Moderator roles, templates, model policy, transcript-as-authority. We take `observe` (outstanding obligations) and one-shot `wait` as a join; we do not take transcript-as-authority or cold-host lineage reconstruction |
| `ravi` | Bun / TS | Durable sessions, provider adapters, daemon, SQLite/NATS, tasks, artifacts | Too many objects and stores. We take the explicit `send --wait` / no-wait split and JSON traces |
| `agent-backbone` | Python | Daemon, messages gated on agent state, `inspect` | Alpha and POSIX-only; SQLite. Ruled out on platform alone |
| `hauntty` | Go | Stateful shell sessions with seq/cwd/rc | Shell, not agent. We take seq-addressed bounded reads and the “unknown vs zero” distinction |
| tmux orchestrators (`ntm`, `tmux-agents`, `reevesagents`) | mixed | Pane-level spawn/send/read/wait, worktree isolation | Rendered text, role/loop workflows, often MCP-only control. We take worktree isolation as an optional worker concern, not a core primitive |

**Adopted into the design from prior art:** cursor/seq bounded reads; outstanding obligations as
a first-class read result; explicit wait vs no-wait; permission-required as reportable
orchestration state; bounded output backlogs; the statement that coordination is a trust
protocol, not a security boundary.

**Observed but not adopted:** cold-host reconstruction of lineage. The design delivers identity
at spawn and keeps no registry to recover it; rebuilding the tree would require the global
registry that the shallow-delegation scope excludes.

**Rejected from prior art:** Moderator/Owner/Spawner roles, templates, virtual models, model
policy, SQLite/NATS, central-daemon-as-authority, transcript-as-store, PTY as the primary
transport, and `session/fork`.

## Open questions this settles

| # | Question | Answer |
|---|---|---|
| 1 | Shape of read/observe | ACP provides a typed event stream. Reads are cursor-addressed and bounded; the orchestration projection reports turn state, pending prompts, pending permissions, and last sequence, separate from raw leaf output |
| 2 | Where orchestration state lives | Live provider sessions are the truth; ACP can reconstruct lists/history/resume. Lineage is not system state at all: identity is injected into the child at spawn, and a parent's knowledge of its descendants is the handles it holds. A durable contact list, if wanted, is an agent-maintained file convention — not a primitive, not a store. No database, no global registry, no cold-host tree reconstruction |
| 4 | The ratchet / who can halt | `session/cancel` is the graceful halt (session survives); process kill is the hard halt. Both are existing primitives, no new object |
| 6 | Visibility: global or scoped | ACP `session/list` is agent-scoped and capability-gated, not global. Self-and-descendants is enforced by the injected identity (`ROOT`/`PARENT`) plus the handles a session holds; the protocol grants no visibility the design did not grant. A shared contact list is a convention, not an enumeration authority |
| 7/8 | Ledger delivery and write authority | Delivery: first prompt as a reference, with `systemPrompt` as an unstable optional path. Write authority remains a product decision; ACP does not constrain it |

Q3 (frequency/cost) and Q5 (audience) are not stack questions.

## Rejected libraries

| Library | Language | Why not |
|---|---|---|
| `acpx` (as runtime) | TS | Pre-1.0; owns session records, scope keys, and TTL |
| `@anthropic-ai/claude-agent-sdk` (as core) | TS | Provider lock, proprietary terms, 0.x, owns the loop |
| `@zed-industries/claude-code-acp` | TS | Superseded by `@agentclientprotocol/claude-agent-acp`; last publish 2026-03-26 |
| `@openai/agents` | TS | OpenAI-centric agent loop, not a session substrate |
| `mastra` / `@mastra/core` | TS | Agent framework with its own state and workflow model |
| `ai` (Vercel AI SDK) | TS | Model/provider abstraction; does not provide long-lived sessions |
| `@opencode-ai/sdk` | TS | Single harness with its own store; viable as one ACP backend, not the generic layer |
| `@openai/codex-sdk` | TS | Single backend |
| `agent-backbone` | Python | Alpha, POSIX-only, SQLite |
| `ravi.bot` | Bun / TS | Bun runtime, SQLite/NATS, many objects |
| `node-pty` as primary transport | TS | Rendered artifact; structured events are preferred for a model consumer |
| MCP as the only presentation | — | An agent-only hidden surface; violates the human/agent correspondence rule |

## Version pins

```jsonc
{
  "engines": { "node": ">=22.13.0" },
  "dependencies": {
    "@agentclientprotocol/sdk": "1.9.0",
    "@agentclientprotocol/claude-agent-acp": "0.93.0",
    "@agentclientprotocol/codex-acp": "2.2.2"
  },
  "optionalDependencies": {
    "node-pty": "1.1.0"
  }
}
```

Adapter packages publish frequently. Bump them one at a time, re-run the ACP handshake test, and
keep the `protocolVersion` assertion at `1`.

## Evidence log

- **ACP v1 schema** (`agent-client-protocol`, `schema/v1/schema.json`) contains:
  `session/new`, `session/load`, `session/resume`, `session/list`, `session/close`,
  `session/delete`, `session/prompt`, `session/cancel`, `session/update`,
  `session/request_permission`, `session/set_mode`, `session/set_config_option`.
- **`session/list`** requires `sessionCapabilities.list` and supports `cwd` filtering plus an
  opaque `nextCursor`.
- **`session/prompt`** is a request that resolves at turn end; `session/update` notifications
  stream thinking, message chunks, tool calls, plans, usage, and notices.
- **Claude and Codex adapters** were downloaded and inspected: both reference `session/list`,
  `session/load`, `session/resume`, and `sessionCapabilities`.
- **Claude adapter** declares `systemPrompt` capability with `append` and `override` modes on
  `session/new`, `load`, `resume`, and `fork` (unstable ACP field).
- **Registry data (npm, 2026-10-19):** versions, publish dates, licenses, and weekly downloads
  as listed in the Decision table and runner-up sections.
