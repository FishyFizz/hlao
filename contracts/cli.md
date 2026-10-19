# Contract — `hlao` CLI

The human and the agent use the same commands, flags, and outputs. `--json` changes the
rendering, never the semantics.

## Commands

```
hlao spawn <backend> [message] [--name N] [--cwd DIR] [--prompt TEXT | --prompt-file F]
                [--stdin] [--wait] [--timeout DUR] [--mode ID]
                [--parent SESSION] [--permission allow|ask|deny] [--env K=V]...
hlao send [<id>] [message] [--self] [--stdin | --prompt TEXT | --prompt-file F]
                [--wait] [--timeout DUR]
hlao read [<id>] [--self] [--since N] [--limit N] [--raw] [--verbose] [--timestamps]
hlao wait [<id>] [--self] [--until idle|permission|exit|change] [--since N] [--timeout DUR]
hlao list [--all] [--cwd DIR]
hlao cancel [<id>] [--self]
hlao close [<id>] [--self] [--force] [--tree]
hlao permit [<id>] [--self] [--allow | --deny | --option ID] [--always]
hlao mode [<id>] [modeId] [--self]
hlao rename <id> <name>
hlao rename <id> --clear
hlao rename --self <name>
hlao rename --self --clear
hlao agents [--cwd DIR]
hlao doctor
hlao whoami
hlao down [--force]
hlao help [command]
hlao version
hlao --version
```

Global flags on every command: `--json`, `--home DIR`, `--no-color`, `--help`. `--` ends
option parsing; everything after it is positional.

Sessions are resolved by exact id first, then unique name, then unique id prefix, all within
the caller's scope. Duplicate names and ambiguous prefixes are `ambiguous_id` with
`details.candidates`. `send`, `mode`, and `rename` require `--self` to target the caller
because their first positional is a message, mode, or new name. `read`, `wait`, `cancel`,
`close`, and `permit` default to `HLAO_SESSION_ID` when it is set and no id is given. A target
supplied both positionally and with `--self` is `bad_request`.

`--tree` on `close` is a CLI assembly: list the caller's visible subtree (including retained
closed sessions, so lineage is not broken by an intermediate that already closed), then close
each live descendant deepest-first. It is not a supervisor method. Its `--json` result is
`{ count, sessions: SessionView[], skipped }`, where `skipped` counts nodes that were already
terminal.

`permit --always` (with `--allow`) switches the session's HLAO policy to `allow` after
answering, preferring the provider's `allow_always` option when offered. `mode` reads
(`{ currentModeId, availableModes }`) or switches (`{ session }`) the provider's native
permission mode; an unknown mode is `bad_option`, and a backend with no modes is
`bad_request`.

`rename` sets an operator label or clears it. A name is stored on the live session and in the
event log (`session.renamed`); it is injected into the adapter environment as `HLAO_NAME` at
spawn. Renaming does not change identity or scope.

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
| `1` | any error (usage, config, supervisor, forbidden, spawn failure) |
| `2` | the bounded wait expired (`wait`, `send --wait`, `spawn --wait`) |
| `3` | the session ended before the awaited condition could be met; `--until exit` still exits `0` |

A timeout is not an error: the work continues, and the command says so. Exit `3` means the
condition is now impossible, not that the command failed to run.

## `--json` output

- Success: one JSON object, exactly the method's `result` (session views included).
- Failure: one JSON object `{ "ok": false, "error": { "code", "message", "details"? } }` on
  **stdout**, exit code `1`. Agents that capture stdout always see a parseable document.
- Human mode writes errors to stderr.

There are no ANSI escapes when stdout is not a TTY, when `NO_COLOR` is set, or under
`--json`.

## Environment read by the CLI

| Variable | Meaning |
|---|---|
| `HLAO_HOME` | runtime home; `--home` overrides |
| `HLAO_SESSION_ID` | caller identity; absence means operator scope |
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
  one is known, and ends with a scope footer (`operator` or `self+descendants`).
- Every command that mutates orchestration state prints what changed, not just "ok".
- `doctor` prints one line per check with `✓`/`✗`/`!`, and exits non-zero only when a
  required check fails.
