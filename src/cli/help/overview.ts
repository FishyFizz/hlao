export function fullHelp(): string {
  return `HLAO — a primitive surface for agent orchestration.

One supervisor owns live agent sessions; the human operator and any agent drive
the same commands. Reads are bounded and cursor-addressed. Waits are one-shot.
There is no scheduler and no session store.

Usage:
  hlao spawn <backend> [message] [options]     open a session
  hlao adopt <backend> <provider-id> [--cwd DIR] [--fork] [--parent S]
                                             take a provider session into this instance
  hlao provider sessions <backend> [--cwd DIR | --all]
                                             list the provider's own sessions
  hlao children [--provider ID | --self]       provider ids this parent attached
  hlao send [<id>] [message] [--wait]          deliver a prompt (steer or queue)
  hlao read [<id>] [--since N | --before N] [--type T] [--grep TEXT]
                [--after TIME] [--until TIME] [--regex] [--context N]
                                             read orchestration state + events
  hlao read [<id>] --follow [--jsonl] [--out FILE]
                                             watch new events / save one page
  hlao export [<id>] [--out FILE] [--jsonl]  full retained history
  hlao export --all --out DIR                 every session plus a manifest
  hlao watch [--all | --root S] [--type T] [--grep TEXT] [--regex]
                                             merged live timeline across sessions
  hlao wait [<id>...] [--any|--all] [--until idle|settled|permission|exit|change]
                [--root S | --status S | --idle DUR]   one-shot await, one or many
                                             sessions; selectors are a client assembly
  hlao get [<id>]                              one session's state, no events
  hlao find TEXT [--all] [--type T] [--after TIME] [--until TIME] [--regex]
                [--context N]                  search events across sessions
  hlao usage [--root S] [--since TIME] [--until TIME] [--group session|root|model]
                                             fleet cost and context snapshots
  hlao list [--all] [--cwd DIR]                sessions in this instance
  hlao list [--wide] [--usage] [--tree] [--watch] [--fields LIST] [--no-cwd]
                                             dashboard / usage / lineage
  hlao cancel [<id>]                           stop the active turn; discard queue
  hlao close [<id>] [--force] [--tree]         end a session
  hlao close --idle DUR | --status S | --root S [--dry-run] [--forget]
  hlao permit [<id>] --allow|--deny|--option ID [--request ID]
                                             answer a pending permission (operator)
  hlao elicit [<id>] [--accept key=value ... | --decline | --cancel]
                                             answer a provider question
  hlao mode [<id>] [modeId]                    read any; set a provider mode (operator)
  hlao option [<id>] [key value]               read or set provider config options
  hlao queue [<id>] | queue drop [<id>] N      inspect or drop queued prompts
  hlao queue drop <id> --id msg-XXXXXXXX       drop one message by id
  hlao rename <id> <name> | --clear            label a session
  hlao agents [--cwd DIR]                      configured backends (local)
  hlao status [--start]                        supervisor state without starting one
  hlao logs [--lines N] [--follow]             supervisor diagnostics
  hlao config show|path|validate               local configuration
  hlao reload                                  re-read config for new spawns
  hlao doctor [--start] [--probe]                 environment and connectivity checks
  hlao whoami                                  this shell's identity and lineage
  hlao skill [path]                            the agent-facing HLAO skill
  hlao down [--force] [--export DIR]           stop the supervisor; optionally
                                             export every session first
  hlao help [command]                          this help or one command
  hlao version

Global options:
  --json                 machine output; errors are {"ok":false,"error":...}
  --json=envelope        wrap success as {"ok":true,"command","result"} and
                         errors as {"ok":false,"command","error"}; implies --json
  --home DIR             runtime home (default $HLAO_HOME or ~/.hlao)
  --no-color             disable ANSI colours (NO_COLOR also works)
  -h, --help             help
  --                     treat the rest of the line as positionals

Addressing:
  A session is addressed by its id, an unambiguous id prefix, or its name.
  Inside a spawned session, read/wait/cancel/close/permit default to the
  caller when <id> is omitted. send/mode/rename need --self for that, because
  their first positional is a message, mode, or new name.

Identity:
  An operator shell has no HLAO_SESSION_ID. A spawned agent inherits
  HLAO_SESSION_ID, HLAO_NAME, and its lineage. Every session in this HLAO
  instance is addressable by every caller, so lineage is context, not a scope.
  hlao whoami reports what this shell is.

Durations: 500ms, 30s, 5m, 2h, 1d, or a bare millisecond count. 0 disables.
Times: an ISO-8601 timestamp, "now", or a duration with a unit meaning "that
  long ago" (for example --after 2h, --until 30m).

Exit codes: 0 ok · 1 error · 2 a bounded wait expired (work continues) ·
  3 the awaited condition was lost because the session ended.

Examples:
  hlao spawn claude "Audit the build log and report the first failure."
  hlao provider sessions claude --cwd D:\work\svc        # the provider's own list
  hlao adopt claude 7f3c9a1e --cwd D:\work\svc           # take it into this instance
  hlao spawn claude --resume 7f3c9a1e --cwd D:\work\svc   # reattach by provider id
  hlao spawn claude --fork 7f3c9a1e --cwd D:\work\svc     # copy it, leave the source alone
  hlao send --self "Check the log again."     # deferred until this turn ends
  hlao read --since 42
  hlao wait --until permission --timeout 10m
  hlao permit a1b2c3 --allow            # operator shell only
  hlao permit a1b2c3 --request req-7 --deny --always
  hlao elicit a1b2c3 --accept question_0="Build"
  hlao mode a1b2c3 auto                 # operator shell only
  hlao rename a1b2c3 builder
  hlao list --json`;
}
