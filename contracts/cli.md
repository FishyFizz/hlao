# Contract — `hlao` CLI

The human and the agent use the same commands, flags, and outputs. `--json` changes the
rendering, never the semantics.

## Commands

```
hlao spawn <backend> [message] [--name N] [--cwd DIR] [--prompt TEXT | --prompt-file F]
                [--stdin] [--wait] [--timeout DUR] [--mode ID]
                [--permission allow|ask|deny] [--env K=V]...
hlao send <id> [message] [--stdin] [--wait] [--timeout DUR]
hlao read <id> [--since N] [--limit N] [--raw]
hlao wait <id> [--until idle|permission|exit|change] [--since N] [--timeout DUR]
hlao list [--all] [--cwd DIR]
hlao cancel <id>
hlao close <id> [--force] [--tree]
hlao permit <id> [--allow | --deny | --option ID] [--always]
hlao mode <id> [modeId]
hlao agents [--cwd DIR]
hlao doctor
hlao whoami
hlao down [--force]
hlao help [command]
hlao version
```

Global flags on every command: `--json`, `--home DIR`, `--help`.

Session ids may be exact handles or unambiguous prefixes. A prefix matching more than one
visible session is an error listing the candidates.

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

A timeout is not an error: the work continues, and the command says so.

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
| `HLAO_PARENT_ID`, `HLAO_ROOT_ID`, `HLAO_DEPTH`, `HLAO_BACKEND` | inherited identity, reported by `whoami` |
| `HLAO_CLI` | absolute CLI path, set for spawned sessions |
| `NO_COLOR` | disables ANSI output |

## Human rendering guarantees

- `spawn` prints the handle and a ready-to-run `read` cursor command.
- `read` coalesces streamed message chunks into readable text and ends with the next cursor
  when more events exist. Adapter stderr and command-list churn are hidden in human mode
  unless `--raw`; they are always present in the JSON result. Original ACP payloads are
  returned only with `--json --raw`.
- `list` colours status only in a TTY and always prints a header.
- Every command that mutates orchestration state prints what changed, not just "ok".
- `doctor` prints one line per check with `✓`/`✗`/`!`, and exits non-zero only when a
  required check fails.
