# Changelog

## 0.11.0 — unreleased

### Added

- HLAO advertises ACP `session.compaction`, `session.notices`, and the experimental `plan`
  capability. Provider-native session state is now first-class: compaction updates and
  summaries, plan updates/removals, provider titles, agent name/version, and ACP inter-session
  messages.
- `SessionView` adds optional `compaction`, `plan`, `title`, `agentName`, and `agentVersion`.
  `get` shows them; `list` uses a provider title only as a display fallback; `list --wide` adds
  an `AGENT` column.
- Human `read` renders compaction summaries, plan deltas/removals, ACP session messages
  (`from <sender> › text`), and `user.message` lines instead of bare event names.
- Context pressure emits a warning notice at 75% and an error notice at 90% of the provider's
  context size, derived from usage events. There is no new timer.
- Protocol 2.5 (additive): new event type `session.message`; new capabilities
  `session.compaction`, `session.notices`, `session.plan`, `session.title`, `session.agent`,
  and `session.messages`.

### Changed

- `plan_update` keeps its existing `update` field and adds normalized `planId`, `kind`,
  `entries`, `uri`, and `content`; `plan_removed` carries `planId`.
- `subagents` remains deliberately unadvertised. ACP session-directed messages are gated by
  that capability, so a compliant adapter will not send them; HLAO still projects them
  defensively if a custom adapter does. Provider subagent sessions are out of scope.

### Fixed

- Piping `read --jsonl` or `export --jsonl` to a reader that exits early (`| head`) no longer
  crashes with an unhandled EPIPE; the CLI ends output quietly.
- `read --jsonl --jsonl-page` now emits its page metadata line without requiring `--follow`.
- An idempotent `send` repeat reports `queued: false` and `duplicate: true` (no new work was
  accepted) plus `pending` for the original message's active/queued state.
- `tool.update` projects the adapter's `rawInput`, so `read --verbose` shows the command, path,
  or content that claude-style adapters send only on the update. Empty `{}` payloads are hidden.
- `--root` now requires the job root. Passing a child id is refused with the resolved root and
  the `--tree <id>` alternative instead of silently widening close/policy/permit/cancel/wait
  to the whole job (including the caller and unrelated siblings). `--tree <id>` selects that
  session's actual subtree.
- `logs --follow` exits promptly and quietly on SIGINT/SIGTERM in a non-tty pipeline.
- Documented that `agent.message`/`agent.thought`/`user.message` are streaming deltas: consumers
  assemble per `messageId`, and `--grep` cannot match text split across chunks. Also documented
  that `spawn.nextSeq` is a start-of-history cursor, not the same field as `read.nextSeq`.

## 0.10.0 — unreleased

### Added

- Human `read` names the actor on every actor-bearing event: `operator` or `from <id>` for
  prompts, and `from`/`by` for queue, rename, close, cancel, and creation events. Queue and
  discard lines carry the message id, sender, and bounded preview.
- `hlao get` prints a state block with status, turn, queue, settlement, policy, modes, config
  options, usage, pending permission, lineage, exit, and cwd. `get --brief` keeps the old
  one-line header. `list --wide` adds REQUESTER and MODEL.
- A supervisor crash is recorded and announced: `status` and `doctor` report the previous
  pid, and the autostarting command prints one warning. `lastCrash` is additive wire metadata.
- The first prompt records `injected: { skill, path, blocks }`, and the skill pointer ends
  with a blank line so a block-concatenating adapter cannot glue it onto the operator's text.
- `supervisor.lastCrash` and `prompt.injected` are additive protocol 2.4 capabilities.

### Changed

- `wait --until settled` now returns the computed exit code in human mode; termination is a
  valid completion (exit 0). `idle` is documented as the historical completion alias, with its
  terminal exit-3 exception, and a permission stop is named `settled (permission)`.
- An invalid config fails startup instead of creating a degraded empty instance; autostart
  prints the parse error and exits 1. This also makes `status --start` exit 1 on bad config.
- `list --cwd` filters locally, so a missing match still reports the true instance counts;
  `--cwd` is exact and `--cwd-prefix` is a subtree.
- The skill and README distinguish inside-turn from between-turn. A busy `send --self --wait`
  is rejected with the deferred form instead of deadlocking. A parked permission is answered
  by the operator or parent, not the parked session itself.
- Terminal sessions report `closed`/`failed`, not `is closing`; send/spawn print the message
  id; wait timeouts show the requested duration; read cursors show the date on a new day;
  notice severity is visible; `raw` events say when the payload is hidden; unknown commands
  suggest the nearest command.
- `package.json` is the single version source; the lock file, CLI, skill metadata, and
  changelog heading are checked against it.

## 0.9.0 — unreleased

### Changed

- Maintenance-only pass: split oversized modules behind stable barrels, removed duplicated
  logic and dead exports, and aligned the test harness with the wire types. No behavior,
  wire, event, flag, or exit-code change.

## 0.8.0 — unreleased

### Added

- The HLAO skill ships with the package, is injected once as a separate first-prompt block,
  and is exposed through `HLAO_SKILL`/`HLAO_SKILL_VERSION`; `spawn --no-skill` suppresses the
  pointer.
- Message ids and idempotency keys make delivery retry-safe; `SendResult.outcome` reports
  `completed`, `cancelled`, or `timed_out`.
- `createdBy` records the spawn requester; `whoami` reports the live name; `list --mine`
  scopes to the caller's root.
- POSIX adapters run in their own process group, and `close --force`/`down` signal it.
- Windows shim readiness, spawn-wait recovery hints, and bounded partial text on timeout.

## 0.7.0 — unreleased

### Added

- Protocol `2.2` (additive): `wait --until settled` (no active turn and no queued prompts;
  also satisfied by a pending permission or a terminal session), `change` filters
  (`types`/`grep`), `SessionView.settled`, `SessionView.lastEvent`, and
  `shutdown.retainedDiscarded`. New capabilities: `wait.settled`, `wait.filters`,
  `session.settled`, `session.lastEvent`.
- `hlao export <id> [--out FILE] [--jsonl]` pages the full retained history. `read --out`
  remains a single bounded page; export is the supported recovery path before `down`.
- `down --dry-run` lists the sessions that would be closed or discarded; `down` warns about
  live and retained terminal sessions and reports both counts.

- Changing `policy` now answers a parked request when the new policy implies an answer
  (`allow`/`deny`); `ask` leaves it parked and the CLI prints the `permit` hint.
- `wait --fail-if-failed` and `read --follow --fail-on-error` make adapter failure visible to
  scripts.
- `list` always reports live/retained counts, resolves `--root` against the full table,
  implies `--all` for `--tree`, normalizes Windows cwd case, adds CREATED/EVENT and per-status
  summary columns, and labels per-session context instead of summing non-additive tokens.
- `read` prints an `older` cursor hint, says "no matching events" when filters are empty, and
  `--jsonl-page` adds per-page cursor/truncation metadata.
- Adapter-derived strings (stderr events, logs, error details, option names) are sanitized at
  the render boundary, including C1 and bidi controls; tables use display width for CJK/emoji.
- Help and contracts describe universal addressing; the stale "sees itself and its
  descendants" and "a parent may" text is gone, project config errors name their file, and a
  help test guards the wording.
- The acceptance examples isolate `HLAO_HOME`, clean up in `finally`, use the turn result
  instead of one read page, and use a local sleep instead of `wait --until change` as a timer.
- `wait`, `cancel`, `permit`, and `policy` accept the `close` selector grammar (`--root`,
  `--tree`, `--status`, `--idle`, `--except-self`) as client assemblies over
  `sessions.list`. `cancel --wait` confirms settlement.
- `hlao get <id>` prints one session's state without events.
- `hlao find TEXT` searches events across sessions with a bounded `list` + paged `read --grep`
  loop; `--all` includes retained histories.
- `permit --all-pending` answers every parked request, reporting per-session failures without
  stopping the rest.
- `--json=envelope` (ADR 0010) wraps any command's success as
  `{ok:true,command,result}` and failure as `{ok:false,command,error}`. Streaming JSON wraps
  each line; `--jsonl` is excluded. Default `--json` shapes are unchanged.

### Fixed

- `close --tree --dry-run` no longer closes the tree.
- `wait --until idle` no longer resolves between queued turns; an idle session with a queue is
  reported as busy by `list`, `close --status idle`, and `close --idle`.
- `nextSeq` is now the last scanned seq, so a client that pages with it never skips an event
  (`read --follow` included).
- `down` no longer discards retained failed/closed histories without reporting them.

## 0.6.0 — unreleased

### Added

- The wire is defined over framed streams rather than a socket implementation
  (`contracts/stream.md`, ADR 0009). `src/stream.ts` is the single transport seam; the
  supervisor, client, and liveness probe no longer import `node:net` directly.
- A TCP adapter carries the same frames as the named pipe and Unix socket. The supervisor
  does not bind TCP by default, and the supervisor token remains local-IPC authority only.
- Protocol `2.1`: a `hello` may request `stream.persistent`. The connection then stays open,
  multiplexes requests by `id`, and may carry server notifications
  (`type: "notification"`). The 2.0 one-request path is unchanged.
- `stream.subscribe` / `stream.unsubscribe`: fleet view notifications and per-session event
  streaming, with per-session cursors, history replay, and `truncated` reporting. Notifications
  are emitted at the same append point that wakes `sessions.wait`; there is no timer.
- A persistent connection allows at most 64 in-flight requests (`too_many_requests`) and is
  closed when more than 8 MiB sits in its outbound transport buffer. A client resumes from its
  cursor.
- New capabilities: `stream.persistent`, `stream.subscribe`, `stream.resume`.

## 0.5.0 — unreleased

### Changed

- Universal addressing (ADR 0008). One HLAO instance — one `HLAO_HOME`, supervisor, socket,
  and token — is one address space and one swarm boundary. Every session in it is addressable
  by every caller; isolation is another instance.
- `sessions.list` returns a flat `{ sessions }`; `scope` is removed and the CLI footer reports
  the instance session count.
- `callerSessionId` is attribution and self-defaulting, not a visibility filter. A stale caller
  can still act and spawn; its spawn becomes a root.
- The parent-send exception is removed. Siblings, ancestors, and unrelated trees are addressable
  by id, name, or prefix; `forbidden` is reserved.
- Protocol version is 2.0 because the addressing semantics are breaking. `hlao down` can still
  stop a pre-2.0 supervisor during the upgrade; other commands require major equality.

## 0.4.0 — unreleased

### Added

- The socket protocol is now the client contract (ADR 0007). `contracts/protocol.md` documents
  transport, token/scope, versioning, polling, and a raw-client conformance test. The bundled
  CLI is the reference client; a dashboard, TUI, or MCP server uses the same wire.
- Protocol `1.1`: `hello` accepts and returns `{ major, minor }` and reports `capabilities`.
  Major mismatch is `version_mismatch`; additive changes bump the minor.
- `backends.list` exposes the merged builtin/user/project adapter view to any client, with the
  same `cwd` semantics as local `hlao agents`.
- `SessionView.usage` carries the latest `usage_update` snapshot (`used`, `size`, `cost`, `at`).
  `hlao list --usage` adds USAGE/COST columns and a per-currency footer total.
- `sessions.read` filters: `types`, `turn`, and case-insensitive `grep`; backward paging with
  `before`; the result adds `nextBefore`. Filters apply before the page limit, and cursors skip
  non-matching events. CLI: `read --type/--turn/--grep/--before/--jsonl`.
- `sessions.wait` accepts `sessionIds` with `any`/`all`, returning per-target `results` and a
  `pending` reason for targets still waiting when the aggregate resolves. CLI:
  `hlao wait <id>... [--any|--all]`.
- `hlao status` reports the protocol version and capability count; `doctor` checks the major.

### Changed

- The wire version is `major.minor`. The lock file stores the major only; clients also accept
  the pre-0.4 numeric `hello.protocolVersion` from a supervisor that has not restarted.
- `sessions.wait` keeps `session` for a single-id call and always includes `results`.
- `sessions.read` always includes `nextBefore`, and a tail read still reports `hasMore: false`.
- A core-module import of `src/cli/*` fails a unit test, making the client boundary explicit.

## 0.3.0 — unreleased

### Added

- Live permission control: `hlao policy` reads or sets `ask`/`allow`/`deny` without a pending
  request. Every mutating event records the acting caller; prompt events record the sender.
- A child may `send` to its direct parent (ADR 0006). Reads, waits, stop authority, and policy
  control remain forbidden on ancestors.
- Provider config options: `SessionView.configOptions`, `hlao option`, `spawn --model`, and
  `spawn --config KEY=VALUE`, applied before the first prompt.
- Queue visibility and control: `hlao queue`, `queue drop`, `cancel --keep-queue`; queue events
  carry sender and a bounded preview (ADR 0005 amendment).
- Dashboard: `list --wide`, `--tree`, filters (`--status`, `--backend`, `--root`, `--name`,
  `--pending`, `--cwd-prefix`), `--sort`, and the caller-owned `--watch` loop.
- Cleanup: `close --idle`, `--status`, `--root`, `--dry-run`, `--except-self`, and `--forget`
  backed by `sessions.forget` for terminal sessions.
- `read --out FILE` exports a page as JSON. `doctor --probe` starts each adapter through ACP
  `initialize`/`session/new` and closes it.

### Changed

- The CLI is split into `main`, `context`, `args`, `input`, `help`, `render`, and four command
  modules; `agents.list` was removed from the wire because `agents` is local. No behavior moved.
- Read-only probes (`status`, non-start `doctor`) no longer create `HLAO_HOME`.
- `doctor` reports adapter commands as "present", always shows the log path/size, and treats a
  stopped supervisor as installed rather than failed.
- Spawn failures carry the adapter exit code/signal; `session.created` records name, requested
  mode, and env keys.
- A CLI/supervisor version mismatch warns once per process.
- `help` and `version` honor `--json`; `help` parses trailing flags rather than treating them as
  a topic.

## 0.2.0 — unreleased

### Added

- Session names: `rename`, name resolution in the caller's scope (exact id, then unique name,
  then prefix), `HLAO_NAME`, and `*`/**self** addressing hints. Human and JSON outputs show
  names alongside handles.
- `--self` for `send`/`mode`/`rename`; self-defaulting for `read`, `wait`, `cancel`, `close`,
  and `permit` when `HLAO_SESSION_ID` is set.
- `read --follow`: a caller-owned read + one-shot wait loop, with NDJSON pages under `--json`.
- Operations without autostart: `status`, `logs`, local `agents`, local `config
  show|path|validate`, non-mutating `doctor`, and operator-only `reload` for new spawns.
- Long human waits print a TTY progress line after two seconds.
- Supervisor log rotation by size while running (one previous file retained).
- `spawn --wait` prints the handle before waiting in human mode.

### Changed

- `wait` exits 3 when the session ended before the awaited condition; `--until exit` still 0.
- Tail reads report eviction whenever earlier history is missing.
- JSON without `--raw` strips `rawInput`, `rawOutput`, and `content`; human `--verbose` renders
  bounded tool payloads.
- Agent text, titles, and names are stripped of ANSI/control sequences in human output.
- `agents` reports the config file that defined each user or project backend.
- `down` warns before stopping when live sessions will lose their in-memory history.
- Distinct adapter message ids start distinct agent blocks; pending permissions are summarized
  once; human reads show timestamps; `list` prints a scope footer.
- Parser guardrails: rejected extra positionals and flag-like path values, unknown help topics,
  and warnings for inert `--timeout`/`--since`; `send --prompt`/`--prompt-file` added.

## 0.1.0 — 2026-10-19

First complete release of the primitive surface.

### Added

- Per-user supervisor over a Windows named pipe / Unix socket, with autostart, stale-lock
  recovery, graceful shutdown, and a diagnostics log.
- ACP v1 sessions over stdio, one adapter process per session, with `initialize`,
  `session/new`, `session/prompt`, `session/cancel`, and `session/close` when advertised.
- Primitives: `spawn`, `send`, `read`, `wait`, `list`, plus `cancel`, `close`, and `permit`.
- Cursor-addressed event log bounded by count, total bytes, per-event bytes, and per-read
  page bytes, with visible eviction and raw ACP payloads on request.
- One-shot waits on `idle`, `permission`, `exit`, and `change`; timeouts never disturb the
  session.
- Prompt queue with visible depth; `cancel` stops the active turn and discards queued
  messages.
- Permission requests surfaced as orchestration state: default `allow` (auto-answer with a
  recorded `policy:allow`), opt-in `ask`, `deny`, `permit --always` to remove the gate from a
  live session, and provider-native modes through `spawn --mode` and `hlao mode`.
- Identity generated before process start and injected as `HLAO_*` environment variables;
  universal addressing by the supervisor (ADR 0008): every session is addressable, and
  lineage is context, not a scope. (This corrects the earlier "self-and-descendants
  visibility" claim.)
- Backend manifests as data: built-in Claude and Codex adapters plus user and project
  configuration.
- Human and `--json` output for every command; exit code 2 distinguishes a bounded wait
  timeout.
- Atomic lock writes, verified stale-lock recovery, and a `down --force` that never kills an
  unverified pid.
- Windows hard termination takes the adapter's process tree; a prompt failure clears its
  pending permission instead of leaving a false `waiting_permission`.
- Scripted ACP agent and 62 tests: 28 unit and 34 end-to-end through the real CLI and
  supervisor, including the four acceptance assemblies (cron, kanban, delegation, dynamic
  workflow). Real Claude adapter flow verified end to end on Windows, including automatic and
  `--always` permission answers.

### Design decisions

- ADR 0001: persistent supervisor rather than re-attach per call.
- ADR 0002: bounded in-memory event log, no durable transcript.
- ADR 0003: identity at spawn, no stored lineage.
- ADR 0004: permissions are orchestration state (revised same day: default `allow` after a
  real adapter parked on every tool call; provider modes exposed).
- ADR 0005: one serialized turn; cancel clears the queue.
