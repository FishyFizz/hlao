# Changelog

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
