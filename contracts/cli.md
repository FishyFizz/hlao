# Contract — `hlao` CLI

The human and the agent use the same commands, flags, and outputs. `--json` changes the
rendering, never the semantics.

## Commands

```
hlao spawn <backend> [message] [--name N] [--cwd DIR] [--prompt TEXT | --prompt-file F]
                [--stdin] [--wait] [--timeout DUR] [--mode ID] [--model VALUE]
                [--config KEY=VALUE]... [--parent SESSION]
                [--permission allow|ask|deny] [--env K=V]...
hlao send [<id>] [message] [--self] [--stdin | --prompt TEXT | --prompt-file F]
                [--wait] [--timeout DUR]
hlao read [<id>] [--self] [--since N | --before N] [--limit N]
                [--type TYPE]... [--turn N] [--grep TEXT]
                [--raw] [--verbose] [--timestamps] [--jsonl] [--jsonl-page]
                [--follow] [--fail-on-error] [--out FILE]
hlao export [<id>] [--self] [--since N] [--raw] [--jsonl] [--out FILE]
hlao get [<id>] [--self]
hlao find TEXT [--all] [--type TYPE]... [--max N]
hlao wait [<id>...] [--self] [--any | --all]
                [--until idle|settled|permission|exit|change] [--since N]
                [--type TYPE]... [--grep TEXT] [--timeout DUR] [--fail-if-failed]
hlao list [--all] [--cwd DIR] [--cwd-prefix DIR] [--status S] [--backend NAME]
                [--root SESSION] [--name TEXT] [--pending] [--wide] [--tree] [--usage]
                [--sort created|activity] [--watch] [--interval DUR]
hlao cancel [<id>] [--self] [--keep-queue]
hlao close [<id>] [--self] [--force] [--tree] [--forget]
hlao close --idle DUR | --status S[,S] | --root SESSION [--dry-run]
                [--except-self] [--forget] [--force]
hlao permit [<id>] [--self] [--allow | --deny | --option ID] [--always]
hlao mode [<id>] [modeId] [--self]
hlao policy [<id>] [allow|ask|deny] [--self]
hlao option [<id>] [key value] [--self]
hlao queue [<id>] [--self]
hlao queue drop [<id>] <position> [--self]
hlao rename <id> <name>
hlao rename <id> --clear
hlao rename --self <name>
hlao rename --self --clear
hlao agents [--cwd DIR]
hlao status [--start]
hlao logs [--lines N] [--follow]
hlao config show|path|validate
hlao reload
hlao doctor [--start]
hlao whoami
hlao down [--force] [--dry-run]
hlao help [command]
hlao version
hlao --version
```

Global flags on every command: `--json`, `--home DIR`, `--no-color`, `--help`. `--` ends
option parsing; everything after it is positional.

Sessions are resolved by exact id first, then unique name, then unique id prefix, all within
this HLAO instance. Every session in the instance is addressable by every caller. Duplicate
names and ambiguous prefixes are `ambiguous_id` with `details.candidates`. Commands whose
first positional is not an id (`send`, `mode`, `rename`) require `--self` to target the
caller. Read-only forms of `read`, `wait`, `cancel`, `close`, `permit`, `policy`, `option`,
and `queue` default to `HLAO_SESSION_ID` when it is set and no id is given; their setting
forms use `--self`. A target supplied both positionally and with `--self` is `bad_request`.

`--tree` on `close` is a CLI assembly: list the target's subtree (including retained closed
sessions, so lineage is not broken by an intermediate that already closed), then close each
live descendant deepest-first. It is not a supervisor method. Its `--json` result is
`{ count, sessions: SessionView[], skipped }`, where `skipped` counts nodes that were already
terminal.

`permit --always` (with `--allow`) switches the session's HLAO policy to `allow` after
answering, preferring the provider's `allow_always` option when offered. `mode` reads
(`{ currentModeId, availableModes }`) or switches (`{ session }`) the provider's native
permission mode; an unknown mode is `bad_option`, and a backend with no modes is
`bad_request`.

`rename` sets an operator label or clears it. A name is stored on the live session and in the
event log (`session.renamed`); it is injected into the adapter environment as `HLAO_NAME` at
spawn. Renaming does not change the handle or `HLAO_SESSION_ID`. The live name is part of
addressing (a unique name resolves), so a rename can change which token addresses the
session.

`policy` reads a live session's HLAO permission policy or sets it without a pending request.
Inside a session, `policy` with no id reads self and `policy --self <policy>` sets it. Any
caller in the instance may re-policy any session.

`option` lists provider config options or sets one (`option <id> <key> <value>`; `--self` for
the caller). Boolean options accept `true`/`false`; select values must match an advertised
value id. `spawn --model VALUE` selects the option whose category is `model`;
`spawn --config KEY=VALUE` applies any option before the first prompt.

`queue` lists the active turn and every queued prompt with sender, age, and a bounded preview;
`queue drop <position>` removes one (1 is next) and settles its caller as cancelled.
`cancel --keep-queue` stops only the active turn, leaving the backlog to run. Plain `cancel`
still discards the queue.

`list` filters are a client-side projection over all sessions in the instance:
`--status`, `--backend`, `--root` (a session token resolved inside the list), `--name`
(substring), `--pending`, and `--cwd-prefix`. `--wide` adds BUSY, POLICY, MODE, PENDING, and
EXIT; `--tree` groups by root and indents by depth. Human output defaults to `--sort activity`;
JSON preserves supervisor order unless `--sort activity` is explicit. `--watch` is a
caller-owned redraw loop: one full result per line under `--json`, or a cleared screen in a TTY.
It never changes supervisor state.

`close` without selectors closes one session. With `--idle DUR` (idle status and no activity for
DUR), `--status S[,S]`, or `--root SESSION`, it is a CLI assembly over `sessions.list` and
`sessions.close`: targets close deepest-first, terminal sessions are counted as skipped, and
`--forget` removes matching terminal sessions instead (`sessions.forget`). `--dry-run` prints
the targets without changing anything; `--except-self` protects the caller. Forgetting a session
that still has retained descendants is an error, so forget descendants first.

`read --out FILE` writes the current JSON page to FILE and continues normal output (`saved
<file>` in human mode, a stderr note with `--json`). It cannot be combined with `--follow`.

`read` filters are sent to the supervisor and applied before the page limit: `--type TYPE`
(repeatable), `--turn N`, and `--grep TEXT` (case-insensitive literal over the event type and
data JSON; private payloads require `--raw`). `--before N` pages backward and is mutually
exclusive with `--since`. A tail page reports `nextBefore`; pass it to `--before` for the next
older page. `--jsonl` writes one event object per line instead of one page object; it cannot be
combined with `--json` or `--out`. `--jsonl-page` adds a leading `{"page":{...}}` line per
page, so a stdout-only consumer can see cursors and eviction. With `--follow`, `--jsonl`
streams events and re-arms a one-shot `wait --until change`; `--fail-on-error` makes a failed
session exit 3. An empty page with filters says "no matching events".

`export [<id>]` pages forward until `hasMore` is false and returns `{session, events,
earliestRetainedSeq, lastSeq, count, truncated}`. `--out FILE` writes that object (or one
event per line with `--jsonl`); without `--out` the JSON object goes to stdout. It is the
supported recovery path before `down`; `read --out` remains one bounded page by design.

`wait` accepts one id or a list. For several ids, `--any` (the default) resolves on the first
target that satisfies and `--all` when every target does. The JSON result always includes
`results` in request order, each with the target's view, `satisfied`, and `reason`; a target
that does not currently satisfy when the aggregate resolves is `pending`. `--since` is only
valid with one id. `--type`/`--grep` filter the event that satisfies `--until change`.

`wait`, `cancel`, `permit`, and `policy` accept the `close` selector grammar: `--root SESSION`
(whole tree), `--tree <id>` (shorthand), `--status S[,S]`, `--idle DUR`, and `--except-self`.
They are client assemblies over `sessions.list`; a selector takes no positional id, and `wait`
is limited to 100 targets by the wire. `cancel --wait` waits for the selected sessions to
settle and exits 2 on timeout. `permit --all-pending` answers every pending request, reporting
per-session failures without stopping the others. `policy --root SESSION allow` applies one
policy to the set.

`get [<id>]` prints one session's state without events (`sessions.get`). `find TEXT [--all]
[--type T]... [--max N]` scans live sessions (retained too with `--all`) by paging
`read --grep`; it is capped at 20 pages per session and reports when a scan was capped.

`--until idle` means no active turn **and** no queued prompt; the CLI maps it to the wire's
`settled` condition. `--until settled` is the explicit form and treats a terminal session as a
valid completion. For the historical `idle` form, a session that ended first is still
unsatisfied and exits 3. `--fail-if-failed` makes any waited session that ended `failed` exit 3.
The aggregate exit code is `2` for timeout, `3` when a target ended before the condition (or
`--fail-if-failed` saw a failure), and `0` otherwise.

`list --usage` adds CONTEXT (each session's latest `used/size`) and COST columns. The footer
totals cost per currency and says "context: latest per session"; token snapshots are not
additive and are not summed. The JSON session view always carries `usage`, whether or not
`--usage` is passed.

`list` always fetches the full table and reports `{sessions, counts: {live, retained, total}}`
in JSON. Human output hides `closed` by default; `--all`, `--tree`, or `--status closed` show
it, and terminal rows are still counted in the footer. `--root` resolves against the full
table, so a closed root still selects its live descendants. The footer reports live and
retained counts, the number shown when filters are active, and a per-status summary.

There is no per-session scope. Any session in the instance may address any other by id, name,
or prefix; `parentId` is lineage, not permission. If two groups need isolation, run two HLAO
instances with different `HLAO_HOME`, socket, and token.

Every mutating event records the acting caller as `by` (a session id or `"operator"`), and
prompt events record the sender as `from`.

`read --follow` is a CLI-owned loop, not a supervisor method: read a page, then one-shot
`wait --until change` from the page's `lastSeq`, repeating until the session is closed or
failed, or the CLI is interrupted. If a page has `hasMore`, the loop reads again immediately
instead of waiting. In human mode the header is printed once and later pages contain only
events; in JSON mode each complete `ReadResult` is emitted on its own line (NDJSON). Closing
the CLI aborts the pending wait; nothing else is cancelled.

`spawn --wait` in human mode is assembled in two calls: `sessions.spawn` without the prompt
(so the handle is printed immediately), then `sessions.send` with `wait: true`. JSON mode keeps
the single `sessions.spawn` call and its `firstTurn` result. A long human wait on `spawn
--wait`, `send --wait`, `wait`, or `read --follow` writes one progress line to stderr after two
seconds when stderr is a TTY; pipes and JSON never see it.

`agents`, `config`, and `doctor` are local and non-mutating; none autostarts a supervisor.
`agents` reports the file that defined each user or project backend, middle-truncated in human
output. The same merged view is available to any client over `backends.list`; the local command
exists so it works without a supervisor. `status` probes an existing supervisor, reports the
wire protocol version and capability count, and exits 1 when none is running; `--start` opts
into autostart. When nothing is running, `status --json` prints
`{running:false, home, hint}` rather than the error envelope: "not running" is the state being
reported, not a command failure. `logs` reads `<HLAO_HOME>/supervisor.log` directly,
defaulting to the last 50 lines (`--lines 0` = whole file). Under `--json` a plain read returns
`{path, lines: string[]}`; `--follow` polls for appended bytes until interrupted and emits one
`{"path","line"}` object per line (NDJSON), including the initial window.

`config show` prints the effective config and its backends without mutating anything; backend
env values are `***`. It exits 0 even when the file is invalid, including an `error` field, so
the effective defaults remain inspectable. `config validate` exits 1 on an invalid file, and
`config path` prints the path whether or not the file exists.

`reload` re-reads user config in the running supervisor. It is operator-only. New spawns use
the new values; live sessions are untouched. An invalid file makes `reload` exit 1 with
`config_invalid` and leaves the supervisor rejecting later spawns with `config_invalid` until
a valid file is reloaded.

`doctor` exits 1 only when a required check fails. Without `--start`, a missing supervisor is a
warning (`installed`, not running), and backend adapter commands are checked locally; the
check says "present", not "ready". `--probe` implies `--start` and additionally spawns each
available backend, completes ACP `initialize` + `session/new`, and closes it, so it can be slow
and may exercise provider authentication. The diagnostic log path and size are always reported.
`doctor` and `status` warn when the config on disk has a different fingerprint from the one the
supervisor loaded.

`down --json` reports one of:
- `{ stopped: true, sessionsClosed: number }`
- `{ stopped: false, reason: "not_running" }`
- `{ stopped: false, staleLockRemoved: true, pidLeftRunning: boolean, pid? }` — `--force` on a
  lock it could not verify; the pid is never killed without a successful supervisor probe.

`doctor --json` returns `{ ok: boolean, checks: { name, status: "ok"|"warn"|"fail",
detail }[] }` and exits 1 only when a required check fails.

## Duration syntax

`500ms`, `30s`, `5m`, `2h`, `1d`, or a bare number of milliseconds. `0` disables a timeout
where the command allows it.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success, including `wait --until exit` on a failed session |
| `1` | any error (usage, config, supervisor, spawn failure) |
| `2` | the bounded wait expired (`wait`, `send --wait`, `spawn --wait`) |
| `3` | the session ended before the awaited condition could be met; `--until exit` still exits `0` |

A timeout is not an error: the work continues, and the command says so. Exit `3` means the
condition is now impossible, not that the command failed to run.

## `--json` output

- Success: one JSON object, exactly the method's `result` (session views included).
- `help` returns `{topic, help}` and `version` returns `{version}` when `--json` is present;
  `help` with no topic uses `topic: null`.
- Failure: one JSON object `{ "ok": false, "error": { "code", "message", "details"? } }` on
  **stdout**, exit code `1`. Agents that capture stdout always see a parseable document.
- Human mode writes errors to stderr.

There are no ANSI escapes when stdout is not a TTY, when `NO_COLOR` is set, or under
`--json`.

## Environment read by the CLI

| Variable | Meaning |
|---|---|
| `HLAO_HOME` | runtime home; `--home` overrides |
| `HLAO_SESSION_ID` | caller identity for attribution and self-defaulting; not a scope |
| `HLAO_NAME` | the caller's session name, when one was set |
| `HLAO_PARENT_ID`, `HLAO_ROOT_ID`, `HLAO_DEPTH`, `HLAO_BACKEND` | inherited identity, reported by `whoami` |
| `HLAO_CLI` | absolute CLI path, set for spawned sessions |
| `NO_COLOR` | disables ANSI output |

## Human rendering guarantees

- `spawn` prints the handle and a ready-to-run `read` cursor command.
- `read` coalesces streamed message chunks into one block until the adapter's message id
  changes. Cursors show `HH:MM:SS`; `--timestamps` shows the full ISO time. Adapter stderr and
  command-list churn are hidden in human mode unless `--raw`; they are always present in the
  JSON result. `--verbose` renders bounded tool payloads. Original ACP payloads are returned
  only with `--json --raw`.
- A pending permission whose `permission.requested` event is in the page is summarized once in
  the header, not repeated as a full option block.
- Failed and closed headers report `ended` and the exit code or signal instead of a pid.
- A tail read whose history was evicted says how many events are missing and where retained
  history starts.
- ANSI escape sequences and other control characters from agent text, titles, names, and
  adapter diagnostics are stripped from human output.
- `list` colours status only in a TTY, always prints a header, marks the caller with `*` when
  one is known, and ends with an instance footer (`instance · N sessions`).
- A long human wait prints one progress line to stderr after two seconds, only when stderr is
  a TTY; it is cleared when the wait ends.
- Every command that mutates orchestration state prints what changed, not just "ok".
- `doctor` prints one line per check with `✓`/`✗`/`!`, and exits non-zero only when a
  required check fails.
