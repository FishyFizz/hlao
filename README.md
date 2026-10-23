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
NAME     SOURCE   READY  MODE  CONFIG                    COMMAND                     NOTES
claude   builtin  yes    —     —                         …\dist\index.js             Claude Code through the ACP adapter
codex    builtin  yes    —     —                         …\dist\index.js             OpenAI Codex through the ACP adapter
opencode builtin  yes    —     —                         …\opencode.exe acp          OpenCode through its ACP server

$ hlao spawn claude "Audit the build log at build.log and report the first failure." --wait
spawned k7m2qp (claude) in D:\work\svc  provider 4f2a9c1e  mode default
— turn 1 ended: end_turn —
next: hlao read k7m2qp --since 0

$ hlao read k7m2qp --since 0
k7m2qp  claude  idle
cwd D:\work\svc · turn 1 · seq 12 · mode default · root · pid 21840

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
spawned check (3f9xw2) (claude) in D:\work\svc  provider 7b31de02  parent k7m2qp  mode default

$ hlao provider sessions claude --cwd D:\work\svc
claude provider sessions · cwd D:\work\svc · claude-agent-acp@0.93.0
SESSION ID                           UPDATED  TITLE                CWD           HLAO
4f2a9c1e-…                           2m       Audit the build log  D:\work\svc   k7m2qp · builder · idle
9c0d3b71-…                           1h       —                    D:\work\svc   provider-only

$ hlao adopt claude 9c0d3b71-… --name recovered
adopted recovered (p8k3xz) (claude) in D:\work\svc  provider 9c0d3b71-…  mode auto

$ hlao children --self
PROVIDER ID  BACKEND  NAME   CWD          CREATED
7b31de02     claude   check  D:\work\svc  2026-10-21 10:00

Every session in an HLAO instance is addressable by every caller. An agent can `send` to,
read, wait on, cancel, or close its parent, a sibling, or an unrelated session; `parentId` is
lineage, not authority. `HLAO_SESSION_ID` is attribution and self-defaulting, not a scope. If
two groups of agents need isolation, run two HLAO instances with different `HLAO_HOME`, socket,
and token — the instance is the hard swarm boundary.

## Requirements

- **Node.js >= 22.13** (developed on 26.8.1). The ACP SDK is pure TypeScript; there is no
  native build step.
- **A backend with its own provider authentication.** The bundled `claude` and `codex`
  adapters wrap their provider runtimes and inherit the environment; the `opencode`
  builtin starts the OpenCode ACP server from an installed `opencode`. A missing adapter or a
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

`hlao doctor` checks Node, the runtime home, config parsing, adapter command presence, the
diagnostic log, and the supervisor when one is running. It never starts a supervisor by
default; `hlao doctor --start` launches one, and `hlao doctor --probe` also starts each
available adapter through ACP `initialize` + `session/new` and closes it.

## Commands

| Command | What it does |
|---|---|
| `hlao spawn <backend> [message]` | Open a session from a configured backend. Inject identity and the skill pointer, optionally send the first message. `--name` gives it a label; `--no-skill` omits the pointer; `--idempotency-key KEY` reuses a session from a retried spawn; `--resume PROVIDER_ID` reopens the provider session an earlier spawn reported, replaying its durable history through ACP `session/load`; `--fork PROVIDER_ID` copies it through ACP `session/fork` and leaves the source untouched. A resume or fork keeps the provider's persisted mode. |
| `hlao provider sessions <backend>` | Read the provider's own session catalog through ACP `session/list`, scoped to `--cwd DIR` or across cwds with `--all`. Prints provider id, age, title, cwd, and the live HLAO attachment when this instance drives the row. Provider-only rows are not HLAO sessions. The read starts a short-lived adapter and stores nothing. |
| `hlao children [--provider ID \| --self]` | Read the historical spawn receipts for a parent provider id: the child provider id, backend, cwd, and name recorded when the parent spawned or adopted it. `--self` resolves the caller's provider id; `--provider` reads `spawn-ledger.jsonl` without a supervisor. History, not liveness. |
| `hlao adopt <backend> <provider-id>` | Take an existing provider conversation into this instance as a new HLAO session. Uses the provider row's cwd, refuses a mismatched `--cwd`, replays history through ACP `session/load`, and returns an already-live provider session as a duplicate. `--fork` copies it instead; `--name` labels it; `--parent` sets lineage; `--no-skill` omits the skill pointer. |
| `hlao send [<id>] [message]` | Deliver a prompt. An idle target runs it immediately; a busy target takes it according to the caller: a session steers into the running turn when the adapter supports it, an operator shell queues. `--steer` / `--queue` override. `--self` targets the caller's session. `--wait` waits for the turn (for a steered message, the running turn). `--stdin` or `--prompt` supplies the text. Every send returns a `msg-…` id; `--idempotency-key KEY` makes a retry return the original instead of enqueuing twice. |
| `hlao read [<id>] [--since N \| --before N]` | Orchestration state plus a bounded page of typed events. Filters `--type`, `--turn`, `--grep` (literal or `--regex`), `--after`/`--until` time bounds, and `--context N` neighbors; `--follow` keeps reading; `--jsonl` streams one event per line; `--out FILE` saves the page; `--verbose` includes bounded tool payloads; `--raw` includes original ACP payloads. Compaction, plan deltas, provider messages, and user lines render as first-class events. |
| `hlao export [<id>] [--out FILE]` | Page the full retained history to JSON (or `--jsonl`). Reports the count and whether earlier history was already evicted. `--all --out DIR` writes every session plus `manifest.json`, whose entries include the durable provider id (`agentSessionId`); it refuses to overwrite an existing export. |
| `hlao get [<id>]` | One session's orchestration state without reading events, including provider title, agent/version, plan, compaction, provider mode, usage, the pending permission queue or question, and lineage. |
| `hlao find TEXT` | Search events across sessions (`list` + paged `read --grep`) with the same time/regex/context filters. Prints a time, session, seq, and one-line snippet per match; `--all` includes retained histories. |
| `hlao watch [--all \| --root S]` | One merged live timeline across the fleet over the persistent stream. Attaches sessions that appear, labels events by session, reconnects with cursors, and filters with `--type`, `--grep`, and `--regex`. History is not replayed; use `read`/`export`. |
| `hlao usage [--root S] [--since T] [--until T]` | Fleet cost and context snapshots, grouped by `session`, `root`, or `model`. Cost is additive per currency; context is never summed. A window reads the latest `usage` event per session. |
| `hlao wait <id>... [--any \| --all] [--until ...]` | One-shot await on `idle`, `settled`, `permission`, `exit`, or a filtered `change`, for one session or a list. A timeout returns 2; a session that ended first returns 3 (for `settled`, termination is a valid completion). |
| `hlao list [--all] [--cwd DIR]` | All sessions in this HLAO instance, with an instance footer and the caller marked. `--wide` adds requester/model/agent/mode/pending/exit; `--usage` adds the latest tokens/cost and a total; `--tree` shows lineage; filters, `--mine` (the caller's root subtree), and `--sort activity\|created` narrow the view; `--watch` redraws (NDJSON with `--json`). In a TTY, columns drop (CWD first) and long cells shorten to fit; `--fields`, `--no-cwd`, and `--compact` project the table or JSON. |
| `hlao cancel [<id>]` | Stop the active turn and discard queued messages. `--keep-queue` stops only the turn. |
| `hlao close [<id>] [--tree]` | End a session; `--tree` closes descendants first. Bulk selectors `--idle DUR`, `--status S`, `--root S` support `--dry-run`; `--forget` removes terminal rows. |
| `hlao permit [<id>] --allow` | Operator-only. Answer a pending provider permission request; `--deny` or `--option ID` also work. Use `--request ID` for one queued request and `--all-pending` for the whole queue. `--always` selects the provider's `allow_always` (`--deny --always` selects `reject_always`); a missing kind is `bad_option`. |
| `hlao elicit [<id>]` | Show a pending provider question (ACP form elicitation), then answer it with `--accept key=value ...`, `--decline`, or `--cancel`. |
| `hlao mode [<id>] [modeId]` | Read any session's provider mode; setting one is operator-only. Bulk set with `--root`, `--tree`, `--status`, or `--idle`. |
| `hlao option [<id>] [key value]` | Read or set provider config options such as model and reasoning effort. |
| `hlao queue [<id>]` / `hlao queue drop [<id>] N` | Inspect queued prompts with sender, message id, and preview, or drop one. `queue drop <id> --id msg-…` targets a message id. |
| `hlao rename <id> <name>` | Label a session, or `--clear` it. Names are addressable within the instance. |
| `hlao agents` | Configured backends, their source, config file, and whether the adapter command is present. Reads config locally so it works without a supervisor; the same view is on the wire as `backends.list`. |
| `hlao status [--start]` | Probe the supervisor without starting one; `--start` launches it. Reports the wire protocol version and capabilities. |
| `hlao logs [--lines N] [--follow]` | Read the supervisor's diagnostic log directly. |
| `hlao config show\|path\|validate` | Inspect the local config; backend env values are redacted. |
| `hlao reload` | Re-read user config in the supervisor for new spawns only. |
| `hlao doctor [--start] [--probe]` | Diagnose locally; opt in to starting the supervisor or probing adapters. |
| `hlao whoami` | This shell's role, name, and lineage. Reads the live name when the supervisor is up; never starts one. |
| `hlao skill [--path]` | Print the HLAO skill (also at `$HLAO_SKILL`); `--path` prints its location. |
| `hlao down [--force] [--export DIR]` | Close every session and stop the supervisor. `--export DIR` backs up every session and a manifest first and refuses to stop if any export failed; `--dry-run` reports without writing. `--force` kills only a process that answers as the supervisor; an unverified stale lock is removed without touching its pid. |
| `hlao help [command]` | Full help or one command's help. |
| `hlao version` | Print the CLI version (`--json` for an object). |

Global flags: `--json`, `--json=envelope`, `--home DIR`, `--no-color`, `-h`; they may appear
before or after a session command. The envelope wraps every success as
`{ok:true,command,result}` and every error as `{ok:false,command,error}`; the default `--json`
shapes are unchanged. `help` and `version` honor `--json` too: help returns
`{topic, help}` and version returns `{version}`. `--` ends option parsing, so a message may
start with a dash. Durations are `500ms`, `30s`, `5m`, `2h`, `1d`, or a bare millisecond count.
Exit codes: `0` ok, `1` error, `2` a bounded wait expired (the work continues), `3` a `wait`
that could not be satisfied because the session ended.

A session is addressable by exact id, then unique name, then unique id prefix. Commands whose
first positional is not an id (`send`, `mode`, `rename`) need `--self` to target the caller;
read-only commands (`read`, `wait`, `cancel`, `close`, `option`, `queue`) default to the
caller's session when no id is given, and the setting forms use `--self`. Inside a session,
`hlao read` is enough.

Control is operator-only: `permit`, a `mode` set, and `spawn --mode` from a caller with
`HLAO_SESSION_ID` are refused with `operator_only`. Reads stay open. This closes the normal
paths but is advisory, not an ACL: the instance token is still readable by same-user agents,
so containment needs a separate instance or scoped credential (N-08). The operator answers
from a shell without `HLAO_SESSION_ID` or from the dashboard.

Human reads show `HH:MM:SS` cursors (`--timestamps` switches to ISO), coalesce a streamed
message into one block and start a new block when the adapter's message id changes, and strip
ANSI/control sequences from agent-provided text. Provider-native updates are rendered directly:
`compaction › status · summary`, `plan › 2/5 done · current: …`, `from <sender> › text` for ACP
session messages, and `user › text`. A tail read that lost history says how many events were
evicted. `hlao list` marks the caller with `*` and reports the instance session count; a
provider title is used as a dim display fallback when the operator gave no name.

### Watching and operating a supervisor

`hlao read <id> --follow` is a caller-owned loop: one `read` page, then one-shot
`wait --until change`, repeating until the session ends or Ctrl-C. With `--json`, each page is
one JSON object per line, so a stream can be consumed without framing. The supervisor still
owns no timer. `read --out FILE` writes the current page as JSON while normal output continues;
`export --all --out DIR` and `down --export DIR` are the whole-instance backup paths.

`hlao watch` is the fleet version of `read --follow`: one merged, labelled timeline over the
persistent stream, with per-session cursors, mid-stream session attachment, and reconnect.
`hlao usage` aggregates the cost and context snapshots each session already reports.

`hlao list --watch` redraws the visible sessions every `--interval` (default 2s) and never
starts a supervisor timer. `--wide` adds busy time, requester, model, agent, mode,
pending-permission title, and exit detail; `--tree` indents by lineage. Filters (`--status`,
`--backend`, `--root`, `--name`, `--pending`, `--cwd` exact, `--cwd-prefix` subtree) run over
the instance list, so they only narrow the local view. Human output sorts by recent activity
by default; `--sort created` restores creation order.

`hlao status` probes an existing supervisor and `--start` opts into autostart. A previous
supervisor that stopped answering is recorded: `status` and `doctor` report the old pid, and
the next autostarting command prints one warning. Its live table and retained history are lost;
HLAO does not claim to recover them. `hlao logs` reads
`supervisor.log` directly (rotated at 2 MiB while running, with one previous file) and can
follow it. `agents`, `config`, and `doctor` are local reads; only `doctor --start` starts a
supervisor and `doctor --probe` starts adapters. A long `--wait` prints a progress line on a
TTY after two seconds and leaves the work running if you press Ctrl-C.

Set `HLAO_DEBUG=1` in the environment that starts the supervisor to mirror its diagnostic
lines to stderr as well as the log.

Editing the config does not affect a running supervisor until `hlao reload`. Live sessions keep
the settings they were spawned with; new spawns use the new values. `doctor` and `status` warn
when the file on disk differs from what the supervisor loaded. Backend environment values are
never printed by `agents` or `config show`.

## Client contract

The supervisor listens on a per-user named pipe (Windows) or Unix socket and is the only
boundary a client needs. The wire is defined over framed JSON messages, not over that socket:
`contracts/protocol.md` is the full contract — frames, transport, methods, and views — and
`src/stream.ts` is the adapter seam, so a TCP or other transport can carry the same frames.
The bundled CLI is the reference client; a dashboard, TUI, or MCP server is another client and
can talk to the same wire without private access.

```
human  -> dashboard / TUI  --\
                              >-- socket protocol -> core (supervisor)
agent  -> CLI / MCP        --/
```

Call `hello` first: it returns `protocolVersion: { major, minor }` and a capability list.
Major versions must match; minor versions are additive. The same contract defines
`backends.list`, `backends.sessions` (the provider's own catalog, live-joined to the
supervisor table), filtered/backward/time reads with optional context, multi-id `wait`, and
the `usage` and `firstPrompt` fields on every session view. Protocol 3.1 is additive; a 3.0
client that does not call `backends.sessions` is unaffected.

Polling `sessions.list`/`sessions.read` is the 2.0 live-update model and remains supported.
Protocol 2.1 adds an opt-in persistent stream: `hello` with `stream.persistent`, then
`stream.subscribe` for fleet view changes and per-session events, with per-session cursors and
resume. Notifications are emitted when state changes, so the supervisor still runs no refresh
loop and no timer. Client assemblies (`cancel` then wait, broadcast, bulk permit, `@last`) are
built by looping over wire methods, not added to the wire.

## The two rules under the surface

**`wait` is one-shot.** "Wait 20 minutes" wakes once. There is no recurring timer, so
monitoring is `wait → read → judge → wait`, and the judgement decides whether to wait again.
Recurring work is a loop the caller owns, not a schedule the supervisor owns.

**Reads speak about orchestration state, not the world.** `read` reports which sessions
exist, their status, turn, queue depth, pending permissions, provider mode, last sequence,
and the typed event stream. It never answers "is the build done?" —
that belongs to the agent reading the build log. Raw leaf output is available explicitly
with `--raw`, but it is not the projection the surface is built around.

The same idea in one line: **if a person cannot do it by hand, the agent should not be able to
either.** The CLI is the hand.

## Permissions and modes

HLAO owns no permission policy. The provider's native mode is the coarse policy, and every
provider permission request is relayed to the operator. There is no auto-allow and no
auto-deny.

**Modes.** `hlao spawn claude ... --mode auto` starts a session in the adapter's Auto mode;
`hlao mode <id>` lists the modes and `hlao mode <id> auto` switches a live one. In Claude Code
these are Manual, Accept edits, Plan, Auto, and (where allowed) Bypass permissions. A provider
mode is the way to stop the provider from asking at the source. Setting a mode is
operator-only; an agent can read its mode but not change it.

**The operator's default.** `backends.<name>.defaultMode` in config sets the mode a **new**
session uses when the operator supplies none. The effective mode for a new session is
operator `--mode` → backend `defaultMode` → the provider's own default. Agent-spawned
children always use the backend default for a new session; they do not inherit the parent's
live mode. A resumed or forked session keeps the provider's persisted mode; an explicit
operator `--mode` still overrides. This is the replacement for policy inheritance.

**Every ask parks.** A request appears in `SessionView.pendingPermissions`, in `list
--pending`, in `read`, and satisfies `wait --until permission`. The operator answers with
`hlao permit <id> --allow`, `--deny`, or `--option ID`. Parallel requests queue FIFO and are
visible individually; a second request is never auto-cancelled. The queue is bounded by
`maxPendingPermissions` (default 16); overflow cancels the new request and records
`permission.resolved { by: "system", reason: "queue_full" }`.

```console
$ hlao permit a1b2c3 --allow                       # one pending request
$ hlao permit a1b2c3 --request req-7 --deny --always
$ hlao permit --all-pending --allow                # every queued request
```

`--always` is a provider option selector, not a state change: `--allow --always` requires the
provider's `allow_always` option, `--deny --always` requires `reject_always`, and a missing
kind is `bad_option` with no fallback. With more than one pending and no `--request`, the
command is a `bad_request` that names the request ids.

**The wait is bounded.** `permissionTimeoutMs` (default 30m, `0` = park) is one absolute
one-shot deadline per request. At expiry HLAO selects `reject_once`, then `reject_always`,
else cancels; it never allows, and records `permission.resolved { by: "timeout", reason:
"timeout" }`. An unattended run should set a provider mode or a backend `defaultMode` rather
than rely on answering in time.

**Control is operator-only.** `permit` and any mode set — `hlao mode`, `option <id> mode …`,
`spawn --mode`, or `spawn --config mode=…` — are refused with `operator_only` when the caller
has `HLAO_SESSION_ID`. A parent agent cannot unblock a child; it reports the blocker. The
operator uses a shell without `HLAO_SESSION_ID` or the dashboard. This is advisory (N-08):
the instance token is the real authority.

Provider config options are a third layer: model, reasoning effort, and adapter-specific
settings. `hlao option <id>` lists them and `hlao option <id> model opus` sets one;
`spawn --model opus` and `spawn --config key=value` apply them before the first prompt. They
come from ACP `session/new` and `config_option_update`; a backend that advertises none shows
nothing here.

Provider-native session state is a fourth layer: compaction, plans, titles, agent identity,
notices, and ACP inter-session messages. HLAO advertises the ACP capabilities for compaction,
notices, and plans, and projects the updates into `read`, `get`, `list`, and the JSON session
view. It does not advertise `subagents`: provider subagent sessions are out of scope, and a
compliant adapter therefore will not send ACP session-directed messages. If one does, HLAO
still records and renders the message rather than hiding its content behind `raw`. Context
pressure is derived from usage updates and surfaced as a notice at 75% and 90%; there is no
timer.

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
| `HLAO_SKILL` | absolute path to the HLAO skill file |
| `HLAO_SKILL_VERSION` | the HLAO version that shipped that skill |

The first prompt carries a short pointer to the skill (unless `spawn --no-skill`). The skill
is a usage artifact, not a context payload: it says to pass context verbatim or by reference
and to reference files and images rather than shipping their bytes through the harness.

The agent can run `hlao` from `PATH`, or `node "$HLAO_CLI"` when HLAO is not installed
globally. A worker runs one turn at a time. Inside a turn, use `read`, wait only on *other*
sessions, and report a blocker in your final message. A self-send is a deferred next turn:
omit `--wait`, finish the turn, and let the queued prompt run.

```bash
hlao read --since 42
hlao wait <other-id> --until settled --timeout 10m
hlao send --self "Check the log again."        # runs after this turn
hlao send "$HLAO_PARENT_ID" "Blocked: the lock file is held by another worker."
hlao provider sessions "$HLAO_BACKEND" --cwd "$PWD"   # provider conversations
hlao adopt "$HLAO_BACKEND" <provider-id> --cwd "$PWD" # take one in as a new agent
```

Environment variables expand differently per shell: `$HLAO_PARENT_ID` in POSIX shells,
`$env:HLAO_PARENT_ID` in PowerShell, and `%HLAO_PARENT_ID%` in cmd.exe. An empty expansion can
silently retarget a command at your own session; pass an explicit id when the shell is
uncertain, or read the ids with `hlao whoami`.

Do not run `send --self ... --wait` from inside a turn: the message queues behind the turn
you are in, so the wait cannot finish. HLAO rejects that shape with `bad_request` and names
the deferred form. A session parked on a permission request cannot run a command to answer
itself; the operator or parent answers it.

The worker can also scope a listing to its own job with `hlao list --mine`, and read the
skill with `hlao skill` when it wants the full guidance rather than the pointer.

`--json` makes every command machine-readable. Success prints the result object; failure
prints `{"ok":false,"error":{"code","message","details?"}}` on stdout with exit 1.

## Backends and configuration

Built-ins are `claude` and `codex`, resolved from HLAO's pinned adapter dependencies, and
`opencode`, resolved from an OpenCode install on `PATH` (`opencode acp`). Add a backend
without writing code by adding a manifest:

```json
{
  "waitTimeoutMs": 1800000,
  "sendWaitTimeoutMs": 1800000,
  "permissionTimeoutMs": 1800000,
  "maxPendingPermissions": 16,
  "backends": {
    "my-agent": {
      "command": "node",
      "args": ["tools/my-acp-agent.js"],
      "env": { "MY_FLAG": "1" },
      "description": "in-repo agent",
      "defaultMode": "auto"
    }
  }
}
```

- User config: `<HLAO_HOME>/config.json`, default `~/.hlao/config.json`.
- Project config: `<cwd>/.hlao/agents.json` with a `backends` object. Project definitions
  override user definitions, which override built-ins.
- A backend is `{ command, args, env, defaultMode? }`. Any command that speaks ACP v1 on
  stdio works.
- `defaultMode` is the operator's per-backend spawn mode: operator `--mode` → `defaultMode` →
  the provider's default. Mode names are backend-specific and not normalized.
- `permissionTimeoutMs`: one-shot provider-ask deadline; default 30m, `0` parks forever.
- `maxPendingPermissions`: FIFO queue bound, 1..1000 (default 16).
- `permissionPolicy` was removed in 0.15. Its presence fails with a migration message naming
  `defaultMode`.
- Provider modes are per session: `--mode ID` at spawn (operator), `hlao mode <id> [ID]` later.
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
          │  framed JSON over a pluggable stream (named pipe / Unix socket today)
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
  second authority over "which sessions exist". Provider discovery does not change that:
  `backends.sessions` reads the provider's own catalog and joins the live table; it stores
  no mapping.
- **Identity is generated before the process starts** and injected into its environment, so
  every leaf tool sees it from birth. The HLAO id is an alias for this supervisor's lifetime;
  ACP's own session id is the durable provider handle, reported as
  `SessionView.agentSessionId`.
- **Reads are cursor-addressed and bounded.** The event log is retained by count and bytes.
  Evictions are reported with `truncated`, never silent.
- **Provider history stays reachable.** The bounded log is a projection, not the transcript.
  `spawn --resume <provider id>` reopens the provider session with ACP `session/load`, which
  replays the durable history into the new log with `replay: true` on each event. An agent
  that spawned a session keeps the provider id from its spawn result and uses it to pull the
  interrupted agent back up after a supervisor restart. The interrupted turn itself is not
  replayed; re-issue the prompt as a human would after resuming.
- **A spawn receipt bridges a restart.** A successful spawn or adoption appends
  `{parentProviderId, childProviderId, backend, cwd, name}` to
  `$HLAO_HOME/spawn-ledger.jsonl` once the provider conversation is durable: a resume or
  fork records immediately, and a fresh session records when its first turn starts. A
  session that never ran a turn has no transcript to load, so it is not offered for
  recovery. A parented spawn keys the pair by the parent's durable provider id; an operator
  root spawn records a null parent, so it is listed as recoverable after a restart without
  a parent. A leader resumed into an empty instance can run `hlao children --self` (or
  `hlao children --provider <id>` with no supervisor) and `hlao adopt` each child by
  provider id. The ledger is append-only history, not a live registry: it never claims a
  child is running, and the live table remains the only liveness authority. It lives in the
  same `HLAO_HOME`, so a different home has no receipts. A forked leader has a new provider
  id; read its predecessor's receipts with `hlao children --provider <source-id>`.
- **A fork is a copy, not a branch of HLAO state.** `spawn --fork <provider id>` copies the
  provider session with ACP `session/fork`; the source keeps running and keeps its id. When
  the backend can also load, the copy's history is replayed into the new log. Nothing about
  the fork is recorded in the source session.
- **Provider sessions are discoverable without a registry.** `hlao provider sessions
  <backend> --cwd DIR` reads ACP `session/list` through a short-lived adapter and shows
  provider-only rows alongside live HLAO attachments. `hlao adopt <backend> <provider-id>`
  loads one as a new HLAO session, using the provider row's cwd and keeping the provider's
  mode. The new session has a new HLAO id and lineage; no old HLAO identity is restored.
  The provider session id remains the durable handle; the spawner's own context and the
  spawn-receipt ledger are the record of which ids it spawned.
- **A session runs one turn at a time.** A message sent by an agent to a busy peer is
  injected into that turn when the adapter advertises ACP steering; otherwise, and for
  operator sends by default, it queues visibly. A steered message never starts a second
  turn. `cancel` clears the queue as well as stopping the active turn.
- **Permissions are relayed state.** `waiting_permission` appears in `list`, `read`, and
  `wait --until permission`; the operator answers with `hlao permit`. Parallel asks queue and
  a bounded deadline fails closed. There is no auto-allow. Provider modes are exposed through
  `hlao mode` so the provider can stop asking at the source; the operator's per-backend
  `defaultMode` selects the mode for unattended runs.
- **Provider questions are state, not permissions.** HLAO advertises ACP form elicitation, so
  Claude Code's AskUserQuestion and MCP elicitation reach the operator. A pending question
  appears as `pendingElicitation` and parks the session (`waiting_permission`); `hlao elicit`
  accepts schema-shaped content, declines, or cancels. The permission relay never answers a
  question.
- **No client-side filesystem or terminal capabilities are advertised**, and provider
  subagents are not surfaced. The leaf stays the leaf.

More detail: `docs/architecture.md`, `contracts/`, and `docs/adr/`.

## Troubleshooting

**The supervisor will not start.** `hlao doctor` checks Node, home, config, and backends
without starting anything; `hlao logs --lines 100` shows what the last supervisor said. The
home directory must be writable; on Unix the socket lives at `<home>/supervisor.sock`. A dead
or unresponsive lock is recovered automatically, and `hlao status --start` makes the startup
attempt explicit. A *live* supervisor of another wire major is different: it is reported as
`version_mismatch`, its lock is left untouched, and no command replaces it. Stop it with the
old CLI, or with `hlao down` (legacy path), then retry.

**Every tool call asks for permission.** Check `hlao read <id>` — the header reports the
provider `mode`. There is no HLAO `allow` default, so each ask parks for the operator. Answer
with `hlao permit <id> --allow` (or `--deny`), or stop the provider from asking at the source
with `hlao mode <id> auto` or a backend `defaultMode` (mode names come from the provider).

**A session is stuck in `waiting_permission`.** `hlao read <id>` shows the tool and its
options; `hlao permit <id> --option <id>` answers exactly, `--deny` rejects, and `hlao cancel
<id>` abandons the turn. If the header reports `question: …` instead, it is a provider
elicitation: `hlao elicit <id>` shows the form and `--accept`, `--decline`, or `--cancel`
answers it.

**History has gaps.** The event log is bounded by count and bytes; `read` reports `truncated`
and the first retained sequence. Export anything you need with `hlao export <id> --out
history.json` before `hlao down`, which ends every session and discards live and retained
in-memory history. `export` pages the full history; `read --out` saves one bounded page.

**An agent cannot find a session.** It may be in another HLAO instance (a different
`HLAO_HOME`), already forgotten, or misspelled. Run `hlao list` in the intended instance;
every session in that instance is addressable.

**A provider session is missing from `hlao list`.** It may be provider-only: the provider
has a conversation but this instance does not currently drive it. Run `hlao provider
sessions <backend> --cwd DIR` and then `hlao adopt <backend> <provider-id>`. The provider
catalog is not the HLAO live table; provider-only rows are labelled, never presented as
live sessions.

**`hlao agents` shows an old backend.** `agents` reads the file on disk, while spawns use the
supervisor's loaded config. Run `hlao reload` for new spawns; live sessions keep their settings.
`hlao status` and `hlao doctor` warn when the fingerprints differ.

**The CLI and supervisor report different versions.** A command prints one warning when the
running supervisor's version differs from the CLI. Run `hlao down`; the next command starts the
current version.

## What this is not

- Not a scheduler, DAG engine, task store, or kanban. Those are assemblies, and the examples
  build them.
- Not deterministic. Unfreezing orchestration buys adaptivity and gives up protection from
  your own agents. For a single operator on their own work, that is the trade.
- Not a judgment-improvement layer. A misread log is still a misread log. HLAO makes a
  judgement error reportable, recoverable, and not self-perpetuating.
- Not a security boundary between cooperating agents. Visibility is a coordination rule.
  Any process with the runtime home and lock token can act as the operator.
- Not a PTY fallback. HLAO speaks ACP v1 only; a tool with no ACP adapter is out of scope
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
| `src/` | supervisor, session, protocol, config, client, CLI (dispatch, context, commands, render) |
| `tests/unit/` | pure modules: client, config, events, ids, logger, protocol, render, time |
| `tests/e2e/` | real CLI → real supervisor → scripted ACP agent |
| `tests/fixtures/fake-acp-agent.ts` | an ACP v1 agent with scripted modes |
| `contracts/` | the public surface of each module and the wire |
| `docs/` | product thesis, stack, architecture, ADRs, standing context |
| `examples/acceptance/` | the four assemblies |

## License

MIT. See `LICENSE`.
