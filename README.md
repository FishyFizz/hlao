# HLAO

**Nothing about an agent-run job is decided before the job is understood.**

HLAO is a primitive surface for agent orchestration. A human operator and an agent drive the
same small set of commands — open a session, send a message, read what happened, wait once,
list what you can see. A per-user supervisor owns the live sessions. There is no scheduler,
no task store, no workflow graph, and no global session registry.

The bet is structural. Most orchestration tools freeze decisions at authoring time: a cron
expression, a DAG, a workflow script, a kanban ontology. The agent that can see the situation
is not the agent with authority to change the plan. HLAO removes the frozen thing and leaves
the plain operations, so the next move is decided when the situation is visible.

## What it looks like

```console
$ hlao agents
NAME    SOURCE   READY  CONFIG                    COMMAND                     NOTES
claude  builtin  yes    —                         …\dist\index.js             Claude Code through the ACP adapter
codex   builtin  yes    —                         …\dist\index.js             OpenAI Codex through the ACP adapter

$ hlao spawn claude "Audit the build log at build.log and report the first failure." --wait
spawned k7m2qp (claude) in D:\work\svc
— turn 1 ended: end_turn —
next: hlao read k7m2qp --since 0

$ hlao read k7m2qp --since 0
k7m2qp  claude  idle
cwd D:\work\svc · turn 1 · seq 12 · policy allow · root · pid 21840

#1    14:02:03 session created · claude · D:\work\svc
#2    14:02:03 ACP session ready
#3    14:02:04 you › Audit the build log at build.log and report the first failure.
#4    14:02:04 — turn 1 —
#5    14:02:06 tool › Read build.log [read]
#6    14:02:06 tool › Read build.log → completed
#7    14:02:11 agent › The first failure is at line 41: `tsc: Cannot find module 'retry'`.
#8    14:02:11 — turn 1 ended: end_turn —
```

```console
$ hlao whoami
session k7m2qp · parent — · root k7m2qp · depth 0 · backend claude

$ hlao rename k7m2qp builder
renamed builder (k7m2qp)

$ hlao spawn claude "Check whether the retry package is declared in package.json." --name check
spawned check (3f9xw2) (claude) in D:\work\svc  parent k7m2qp  policy allow

An agent sees itself and its descendants. An operator shell has no `HLAO_SESSION_ID` and sees
everything. That scope is also the halt authority: a session can `cancel` or `close` itself
and its descendants, never its parent or a sibling. Authority follows visibility instead of
being granted by a separate policy.

## Requirements

- **Node.js >= 22.13** (developed on 26.8.1). The ACP SDK is pure TypeScript; there is no
  native build step.
- **A backend with its own provider authentication.** The bundled `claude` and `codex`
  adapters wrap their provider runtimes and inherit the environment. A missing adapter or a
  failure during startup shows up as a spawn error with the adapter's stderr; a provider
  rejection during a turn appears in the session output, not hidden in the supervisor.
- **Windows 11, macOS, or Linux.** The supervisor uses a named pipe on Windows and a Unix
  socket elsewhere.

## Install

From a checkout:

```bash
npm install
npm run build
npm link          # or: npm install -g .
hlao doctor
```

`hlao doctor` checks Node, the runtime home, config parsing, backend readiness, and the
supervisor when one is running. It never starts a supervisor by default; `hlao doctor --start`
launches one and probes it.

## Commands

| Command | What it does |
|---|---|
| `hlao spawn <backend> [message]` | Open a session from a configured backend. Inject identity, optionally send the first message. `--name` gives it a label. |
| `hlao send [<id>] [message]` | Queue a prompt. `--self` targets the caller's session. `--wait` waits for that message's turn. `--stdin` or `--prompt` supplies the text. |
| `hlao read [<id>] [--since N]` | Orchestration state plus a bounded page of typed events. `--follow` keeps reading; `--verbose` includes bounded tool payloads; `--raw` includes original ACP payloads. |
| `hlao wait [<id>] [--until ...]` | One-shot await on `idle`, `permission`, `exit`, or `change`. A timeout returns 2; a session that ended first returns 3. |
| `hlao list [--all] [--cwd DIR]` | Sessions in this shell's scope, with a scope footer and the caller marked. |
| `hlao cancel [<id>]` | Stop the active turn and discard queued messages. |
| `hlao close [<id>] [--tree]` | End a session; `--tree` closes descendants first. |
| `hlao permit [<id>] --allow` | Answer the pending permission request. `--deny` or `--option ID` also work; `--always` stops future asks for the session. |
| `hlao mode [<id>] [modeId]` | Read or switch the provider's native permission mode (Manual, Auto, Accept edits, ...). |
| `hlao rename <id> <name>` | Label a session, or `--clear` it. Names are addressable within the caller's scope. |
| `hlao agents` | Configured backends, their source, and readiness. Reads config locally; never starts a supervisor. |
| `hlao status [--start]` | Probe the supervisor without starting one; `--start` launches it. |
| `hlao logs [--lines N] [--follow]` | Read the supervisor's diagnostic log directly. |
| `hlao config show\|path\|validate` | Inspect the local config; backend env values are redacted. |
| `hlao reload` | Re-read user config in the supervisor for new spawns only. |
| `hlao whoami` | This shell's role, name, and lineage. |
| `hlao down [--force]` | Close every session and stop the supervisor. `--force` kills only a process that answers as the supervisor; an unverified stale lock is removed without touching its pid. |

Global flags: `--json`, `--home DIR`, `--no-color`, `-h`; they may appear before or after the
command. `--` ends option parsing, so a message may start with a dash. Durations are `500ms`,
`30s`, `5m`, `2h`, `1d`, or a bare millisecond count. Exit codes: `0` ok, `1` error, `2` a
bounded wait expired (the work continues), `3` a `wait` that could not be satisfied because
the session ended.

A session is addressable by exact id, then unique name, then unique id prefix. `send`, `mode`,
and `rename` need `--self` to target the caller, because their first positional means
something else. `read`, `wait`, `cancel`, `close`, and `permit` default to the caller's session
inside a session, so `hlao read` is enough.

Human reads show `HH:MM:SS` cursors (`--timestamps` switches to ISO), coalesce a streamed
message into one block and start a new block when the adapter's message id changes, and strip
ANSI/control sequences from agent-provided text. A tail read that lost history says how many
events were evicted. `hlao list` marks the caller with `*` and states whether the scope is the
operator view or self-plus-descendants.

### Watching and operating a supervisor

`hlao read <id> --follow` is a caller-owned loop: one `read` page, then one-shot
`wait --until change`, repeating until the session ends or Ctrl-C. With `--json`, each page is
one JSON object per line, so a stream can be consumed without framing. The supervisor still
owns no timer.

`hlao status` probes an existing supervisor and `--start` opts into autostart. `hlao logs` reads
`supervisor.log` directly (rotated at 2 MiB while running, with one previous file) and can
follow it. `agents`, `config`, and `doctor` are local reads; only `doctor --start` starts a
supervisor. A long `--wait` prints a progress line on a TTY after two seconds and leaves the
work running if you press Ctrl-C.

Editing the config does not affect a running supervisor until `hlao reload`. Live sessions keep
the settings they were spawned with; new spawns use the new values. `doctor` and `status` warn
when the file on disk differs from what the supervisor loaded. Backend environment values are
never printed by `agents` or `config show`.

## The two rules under the surface

**`wait` is one-shot.** "Wait 20 minutes" wakes once. There is no recurring timer, so
monitoring is `wait → read → judge → wait`, and the judgement decides whether to wait again.
Recurring work is a loop the caller owns, not a schedule the supervisor owns.

**Reads speak about orchestration state, not the world.** `read` reports which sessions
exist, their status, turn, queue depth, pending permissions, permission policy, provider
mode, last sequence, and the typed event stream. It never answers "is the build done?" —
that belongs to the agent reading the build log. Raw leaf output is available explicitly
with `--raw`, but it is not the projection the surface is built around.

The same idea in one line: **if a person cannot do it by hand, the agent should not be able to
either.** The CLI is the hand.

## Permissions and modes

A provider may ask before running a tool. HLAO's `permissionPolicy` decides how to answer:

- **`allow` (default)** — answer with the first allow option and record it (`by: policy:allow`).
  The request is still visible in `read`; it does not park the turn.
- **`ask`** — park the session in `waiting_permission`, visible in `list`, `read`, and
  `wait --until permission`. This is the gated mode: `--permission ask` at spawn or in config.
- **`deny`** — answer with a reject option.

`hlao permit <id> --allow --always` answers the current request and switches that live
session's policy to `allow`, so later requests are answered automatically. When the provider
offers an allow-always option, it is preferred, which can stop the provider from asking at all
for matching commands.

Provider-native modes are a separate layer. `hlao spawn claude ... --mode auto` starts a
session in the adapter's Auto mode; `hlao mode <id>` lists the modes and `hlao mode <id> auto`
switches a live one. In Claude Code these are Manual, Accept edits, Plan, Auto, and (where
allowed) Bypass permissions. Using a provider mode is the way to stop the provider from
asking at the source; the HLAO policy is the guarantee that a request cannot silently hang.

## Using it from an agent

A spawned session inherits:

| Variable | Meaning |
|---|---|
| `HLAO_SESSION_ID` | its own handle |
| `HLAO_NAME` | the session's name, when one was given |
| `HLAO_PARENT_ID` | who spawned it |
| `HLAO_ROOT_ID` | the job root |
| `HLAO_DEPTH` | 0 at the root |
| `HLAO_BACKEND` | backend manifest name |
| `HLAO_HOME` | runtime home, for supervisor discovery |
| `HLAO_CLI` | absolute path to the CLI entry point |

The agent can run `hlao` from `PATH`, or `node "$HLAO_CLI"` when HLAO is not installed
globally. A typical worker loop:

```bash
hlao send --self "Check the log again." --wait --timeout 20m
hlao read --since 42
hlao wait --until permission --timeout 10m
```

`--json` makes every command machine-readable. Success prints the result object; failure
prints `{"ok":false,"error":{"code","message","details?"}}` on stdout with exit 1.

## Backends and configuration

Built-ins are `claude` and `codex`, resolved from HLAO's pinned adapter dependencies. Add a
backend without writing code by adding a manifest:

```json
{
  "permissionPolicy": "allow",
  "waitTimeoutMs": 1800000,
  "sendWaitTimeoutMs": 1800000,
  "backends": {
    "my-agent": {
      "command": "node",
      "args": ["tools/my-acp-agent.js"],
      "env": { "MY_FLAG": "1" },
      "description": "in-repo agent"
    }
  }
}
```

- User config: `<HLAO_HOME>/config.json`, default `~/.hlao/config.json`.
- Project config: `<cwd>/.hlao/agents.json` with a `backends` object. Project definitions
  override user definitions, which override built-ins.
- A backend is `{ command, args, env }`. Any command that speaks ACP v1 on stdio works.
- `permissionPolicy`: `allow` (default), `ask`, or `deny`.
- Provider modes are per session: `--mode ID` at spawn, `hlao mode <id> [ID]` later.
- Timeouts are milliseconds. `0` disables a timeout where the command allows it.
- Unknown config keys are rejected, so a typo cannot silently do nothing.

## The acceptance test

`PRODUCT.md` defines done as rebuilding four known orchestration shapes out of the primitives
in user space. All four are runnable:

```bash
node examples/acceptance/cron.mjs --backend claude --interval 30s
node examples/acceptance/kanban.mjs --backend claude --ledger board.md --tasks "a,b"
node examples/acceptance/delegation.mjs --backend claude --task "summarize the README"
node examples/acceptance/workflow.mjs --backend claude --goal "migrate the build"
```

They are tested end to end against a scripted ACP agent, so the assemblies are proven without
a provider account:

- **cron** — a loop, a one-shot wait whose timeout is the timer, and the agent's judgement as
  the termination condition.
- **kanban** — prompts as cards, session status as columns, a ledger file announced by
  reference as the shared board.
- **delegation** — spawn, joining facts in the spawn, wait, read, integrate, close.
- **workflow** — a scout is spawned, its finding decides the next spawn, and an impossible
  verdict stops the plan with the finding returned to the orchestrator.

See `examples/acceptance/README.md`.

## How it works

```
operator / agent shell
          │  hlao <command> --json
          ▼
   CLI (stateless, one request per command)
          │  NDJSON over a per-user named pipe / Unix socket
          ▼
 supervisor (one per HLAO_HOME, detached)
          │  ACP v1 over stdio, one adapter process per session
          ▼
 provider adapter → provider runtime → leaf tools
```

- **The live session table is the state.** The supervisor holds handles to adapter
  processes. There is no database and no global registry. A graceful `hlao down` closes
  every session; a hard kill loses the table and can orphan adapter processes (especially
  on Windows), so `down` is the supported shutdown path. The design accepts this to avoid a
  second authority over "which sessions exist".
- **Identity is generated before the process starts** and injected into its environment, so
  every leaf tool sees it from birth. ACP's own session id is internal.
- **Reads are cursor-addressed and bounded.** The event log is retained by count and bytes.
  Evictions are reported with `truncated`, never silent.
- **A session runs one turn at a time.** Messages queue visibly. `cancel` clears the queue as
  well as stopping the active turn.
- **Permissions are state.** `waiting_permission` appears in `list`, `read`, and
  `wait --until permission`; `hlao permit` answers it. The default policy answers
  automatically, and `permit --always` removes the gate from a live session. Provider modes
  are exposed through `hlao mode` so the provider can stop asking at the source.
- **No client-side filesystem or terminal capabilities are advertised**, and provider
  subagents are not surfaced. The leaf stays the leaf.

More detail: `docs/architecture.md`, `contracts/`, and `docs/adr/`.

## Troubleshooting

**The supervisor will not start.** `hlao doctor` checks Node, home, config, and backends
without starting anything; `hlao logs --lines 100` shows what the last supervisor said. The
home directory must be writable; on Unix the socket lives at `<home>/supervisor.sock`. A dead
or unresponsive lock is recovered automatically, and `hlao status --start` makes the startup
attempt explicit.

**Every tool call asks for permission.** Check `hlao read <id>` — the session header reports
`policy`. The default policy is `allow`; `--permission ask` or a config `permissionPolicy` may
have gated it. Answer once with `hlao permit <id> --allow`, remove the gate with
`hlao permit <id> --allow --always`, or stop the provider from asking at the source with
`hlao mode <id> auto` (mode names come from the provider).

**A session is stuck in `waiting_permission`.** `hlao read <id>` shows the tool and its
options; `hlao permit <id> --option <id>` answers exactly, `--deny` rejects, and `hlao cancel
<id>` abandons the turn.

**History has gaps.** The event log is bounded by count and bytes; `read` reports `truncated`
and the first retained sequence. Export anything you need (`hlao read <id> --since 0 --json`)
before `hlao down`, which ends every session and discards in-memory history.

**An agent cannot see a session.** A spawned session sees itself and its descendants only.
A sibling or parent is outside its scope by design; coordinate through the operator shell or a
common ancestor.

**`hlao agents` shows an old backend.** `agents` reads the file on disk, while spawns use the
supervisor's loaded config. Run `hlao reload` for new spawns; live sessions keep their settings.
`hlao status` and `hlao doctor` warn when the fingerprints differ.

## What this is not

- Not a scheduler, DAG engine, task store, or kanban. Those are assemblies, and the examples
  build them.
- Not deterministic. Unfreezing orchestration buys adaptivity and gives up protection from
  your own agents. For a single operator on their own work, that is the trade.
- Not a judgment-improvement layer. A misread log is still a misread log. HLAO makes a
  judgement error reportable, recoverable, and not self-perpetuating.
- Not a security boundary between cooperating agents. Visibility is a coordination rule.
  Any process with the runtime home and lock token can act as the operator.
- Not a PTY fallback. v0.1 speaks ACP v1 only; a tool with no ACP adapter is out of scope
  until the optional PTY path from `STACK.md` is built.

## Development

```bash
npm run check     # strict TypeScript, sources and tests
npm test          # build, compile tests, run unit + e2e + acceptance
npm run test:unit
npm run test:e2e
```

| Path | What lives there |
|---|---|
| `src/` | supervisor, session, protocol, config, client, CLI |
| `tests/unit/` | pure modules: time, ids, events, protocol, config |
| `tests/e2e/` | real CLI → real supervisor → scripted ACP agent |
| `tests/fixtures/fake-acp-agent.ts` | an ACP v1 agent with scripted modes |
| `contracts/` | the public surface of each module and the wire |
| `docs/` | product thesis, stack, architecture, ADRs, standing context |
| `examples/acceptance/` | the four assemblies |

## License

MIT. See `LICENSE`.
