# Changelog

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
  self-and-descendants visibility enforced by the supervisor.
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
