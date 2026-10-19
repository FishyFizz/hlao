import { booleanOption, type ParsedArgs } from "./args.js";
import { writeJson } from "./context.js";

export function helpRequested(parsed: ParsedArgs, command: string): boolean {
  if (booleanOption(parsed, "help") === true) {
    const text = commandHelp(command);
    if (booleanOption(parsed, "json") === true) {
      writeJson({ topic: command, help: text });
    } else {
      process.stdout.write(`${text}\n`);
    }
    return true;
  }
  return false;
}

export function fullHelp(): string {
  return `HLAO — a primitive surface for agent orchestration.

One supervisor owns live agent sessions; the human operator and any agent drive
the same commands. Reads are bounded and cursor-addressed. Waits are one-shot.
There is no scheduler and no session store.

Usage:
  hlao spawn <backend> [message] [options]     open a session
  hlao send [<id>] [message] [--wait]          queue a prompt
  hlao read [<id>] [--since N] [--raw]         read orchestration state + events
  hlao read [<id>] --follow [--out FILE]       watch new events / export a page
  hlao wait [<id>] [--until idle|permission|exit|change] [--timeout DUR]
  hlao list [--all] [--cwd DIR]                sessions in your scope
  hlao list [--wide] [--tree] [--watch]        dashboard / lineage / redraw loop
  hlao cancel [<id>]                           stop the active turn; discard queue
  hlao close [<id>] [--force] [--tree]         end a session
  hlao close --idle DUR | --status S | --root S [--dry-run] [--forget]
  hlao permit [<id>] --allow|--deny|--option ID  answer a permission request
  hlao mode [<id>] [modeId]                    read or switch a provider mode
  hlao policy [<id>] [allow|ask|deny]          read or set the live permission policy
  hlao option [<id>] [key value]               read or set provider config options
  hlao queue [<id>] | queue drop [<id>] N      inspect or drop queued prompts
  hlao rename <id> <name> | --clear            label a session
  hlao agents [--cwd DIR]                      configured backends (local)
  hlao status [--start]                        supervisor state without starting one
  hlao logs [--lines N] [--follow]             supervisor diagnostics
  hlao config show|path|validate               local configuration
  hlao reload                                  re-read config for new spawns
  hlao doctor [--start] [--probe]                 environment and connectivity checks
  hlao whoami                                  this shell's scope and lineage
  hlao down [--force]                          stop the supervisor
  hlao help [command]                          this help or one command
  hlao version

Global options:
  --json                 machine output; errors are {"ok":false,"error":...}
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
  An operator shell has no HLAO_SESSION_ID and sees every session. A spawned
  agent inherits HLAO_SESSION_ID, HLAO_NAME, and its lineage, and sees itself
  and its descendants only. hlao whoami reports what this shell is.

Durations: 500ms, 30s, 5m, 2h, 1d, or a bare millisecond count. 0 disables.

Exit codes: 0 ok · 1 error · 2 a bounded wait expired (work continues) ·
  3 the awaited condition was lost because the session ended.

Examples:
  hlao spawn claude "Audit the build log and report the first failure."
  hlao send --self "Check the log again." --wait --timeout 20m
  hlao rename a1b2c3 builder
  hlao permit a1b2c3 --allow --always
  hlao mode a1b2c3 auto
  hlao wait a1b2c3 --until permission --timeout 10m
  hlao read a1b2c3 --since 42
  hlao list --json`;
}

export function hasCommandHelp(command: string): boolean {
  return COMMAND_HELP_NAMES.has(command) || command === "help";
}

const COMMAND_HELP_NAMES = new Set([
  "spawn",
  "send",
  "read",
  "wait",
  "list",
  "cancel",
  "close",
  "permit",
  "mode",
  "policy",
  "option",
  "queue",
  "rename",
  "agents",
  "status",
  "logs",
  "config",
  "reload",
  "doctor",
  "whoami",
  "down",
]);

export function commandHelp(command: string): string {
  const help: Record<string, string> = {
    spawn: `hlao spawn <backend> [message] [options]

Open a session from a configured backend. The session's identity is injected
into its environment before the adapter starts.

Options:
  --name LABEL           operator label shown in list/read
  --cwd DIR              working directory (default: current)
  --prompt TEXT          message text (alternative to the positional)
  --prompt-file FILE     read the first message from a file
  --stdin                read the first message from stdin
  --wait                 wait for the first turn to end
  --timeout DUR          bound the first-turn wait (0 = no bound)
  --mode ID              provider permission mode (see "hlao mode <id>")
  --model VALUE          select the model category of provider config options
  --config KEY=VALUE     set a provider config option (repeatable)
  --parent SESSION       spawn under another visible session
  --permission POLICY    allow (default), ask, or deny
  --env K=V              extra environment for the adapter (repeatable)

A session can be addressed by id, id prefix, or name. In human mode --wait
prints the new handle before it starts waiting, so a long first turn is
observable. The spawn result includes the handle, label, policy, and cursor.`,
    send: `hlao send [<id>] [message] [options]

Queue a prompt. One turn runs at a time; a message sent while busy waits in a
visible queue.

Options:
  --self                 target this shell's own session (required when <id> is
                         omitted, because the first positional is the message)
  --stdin                read the message from stdin
  --prompt TEXT          message text (alternative to the positional)
  --prompt-file FILE     read the message from a file
  --wait                 wait for this message's turn to end
  --timeout DUR          bound the wait (0 = no bound)

A timeout exits 2 and leaves the turn running.`,
    read: `hlao read [<id>] [options]

Read orchestration state plus a bounded page of typed events.

Options:
  --self                 target this shell's own session
  --since N              events with seq > N (omit for the most recent page)
  --limit N              page size, 1..1000 (default 100)
  --verbose              human mode: include bounded tool input/output
  --raw                  with --json, include original ACP payloads; in human
                         mode, reveal adapter stderr and command updates
  --timestamps           show full ISO timestamps instead of HH:MM:SS
  --follow               keep reading, then one-shot wait, until the session
                         ends or you press Ctrl-C; --json emits one page per line
  --out FILE             also write this page's JSON result to FILE

The response reports earliestRetainedSeq, lastSeq, nextSeq, hasMore, and
truncated. Tool payloads are omitted unless --raw/--verbose.`,
    wait: `hlao wait [<id>] [options]

One-shot await on orchestration state. It never re-arms.

Options:
  --self                 target this shell's own session
  --until idle|permission|exit|change   default idle
  --since N              baseline for "change" (default: now)
  --timeout DUR          bound; default from config (30m), 0 = no bound

A timeout exits 2. If the session ends before the condition is met, the wait
exits 3 (except --until exit, which exits 0).`,
    list: `hlao list [--all] [--cwd DIR] [--wide] [--tree] [--watch]

List sessions visible to this shell. A session is shown by id and name; an
agent sees itself and its descendants, and an operator sees all. The footer
reports the scope, and a scoped view marks the caller's own session with *.
--all includes sessions that have closed but are still retained for reading.

Filters: --status S[,S], --backend NAME, --root SESSION, --name TEXT,
--pending, and --cwd-prefix DIR (subtree). --sort created|activity (human
default: activity). --wide adds BUSY, POLICY, MODE, PENDING, and EXIT;
--tree groups and indents by lineage. --watch redraws every --interval DUR
(default 2s; JSON emits one result per line) until Ctrl-C.`,
    cancel: `hlao cancel [<id>] [--keep-queue]

Request ACP session/cancel for the active turn. By default every queued message
is discarded as well; --keep-queue stops only the active turn and lets the next
queued message run. The session survives. Inside a session, omit <id> or pass
--self.`,
    close: `hlao close [<id>] [--force] [--tree] [--forget]
hlao close --idle DUR | --status S[,S] | --root SESSION [--dry-run] [--forget]

Close a session. ACP session/close is attempted when advertised, then the
adapter process is terminated. --force skips the protocol close. --tree closes
this session's descendants first (a CLI assembly over list + close). Inside a
session, omit <id> or pass --self.

Bulk mode selects sessions instead of naming one: --idle matches idle sessions
whose last activity is older than DUR; --status matches states; --root matches
a whole job; --except-self excludes the caller. --dry-run prints the targets
and actions without changing anything. --forget removes a terminal session from
the table (retention is otherwise one hour); a session with retained
descendants must have them forgotten first. Closing discards queued messages
and, once retention ends, in-memory history.`,
    permit: `hlao permit [<id>] --allow|--deny|--option ID [--always]

Answer the session's pending permission request. --allow picks the first allow
option, --deny the first reject option, and --option names one exactly.

--always (with --allow) also switches this session's HLAO policy to allow, so
later provider requests are answered automatically. When the provider offers an
allow-always option it is preferred, which can stop the provider from asking at
all for matching commands. Inside a session, omit <id> or pass --self.`,
    mode: `hlao mode [<id>] [modeId]

Read or switch the provider's native permission mode. This is the same switch a
person uses in Claude Code; it is how you stop the provider from asking on every
tool call.

Without modeId: print the current mode and the available modes.
With modeId: request session/set_mode and report the result.
Inside a session, omit <id> to read your own; use --self <modeId> to set it.
`,
    policy: `hlao policy [<id>] [allow|ask|deny]

Read a session's live HLAO permission policy, or set it without needing a
pending request. allow answers provider requests automatically, ask parks them,
and deny rejects them. Inside a session, omit <id> to read your own policy or
use --self <policy> to set it; a parent may set a descendant's policy.

permit --always is equivalent to answering the current request and setting the
policy to allow.`,
    option: `hlao option [<id>] [key value]

Read or set a provider-advertised session config option (model, reasoning
effort, and adapter-specific settings). Values shown with "current" come from
ACP session/new and config_option_update.

Without key value: print every option and its selectable values.
With key value: request session/set_config_option. Boolean options accept
true/false. Inside a session, use --self or --self <key> <value>.`,
    queue: `hlao queue [<id>] [--self]
hlao queue drop [<id>] <position> [--self]

List queued prompts with sender, age, and a bounded text preview, or drop one
position (1 is the next message to run). Dropping settles that caller as
cancelled. Inside a session, omit <id> or pass --self. Cancel with --keep-queue
stops only the active turn.`,
    rename: `hlao rename <id> <name> [--clear]

Give a session an operator-facing name. A unique name can then be used anywhere
a session id is accepted. Duplicate names resolve as ambiguous. --clear removes
the name. Inside a session, use --self <name> (or --self --clear).`,
    agents: `hlao agents [--cwd DIR]

Show built-in, user, and project backends with their source and readiness.
Reads configuration locally and never starts a supervisor. Environment values
are never printed, only their names.`,
    status: `hlao status [--start]

Probe the supervisor without starting one and report pid, version, uptime, live
sessions, protocol, config errors, and whether the config on disk is fresher.
Exits 1 when nothing is running. --start autostarts the supervisor first.`,
    logs: `hlao logs [--lines N] [--follow]

Read the supervisor's diagnostic log directly; no supervisor is needed. The
default is the last 50 lines; --lines 0 prints the whole file. --follow polls
for appended lines until Ctrl-C. With --json, a plain read returns
{"path","lines"}; --follow emits one {"path","line"} object per line.`,
    config: `hlao config show|path|validate

Local, non-mutating configuration inspection.

  show       effective values and backends; backend env values are redacted
  path       the user config path (whether or not it exists)
  validate   parse and validate the file; exits 1 on an invalid config`,
    reload: `hlao reload

Re-read the user config in the running supervisor. New spawns use the new
values; live sessions keep the settings they started with. Operator only.
An invalid file is reported and makes later spawns fail until fixed.`,
    doctor: `hlao doctor [--start] [--probe]

Check node, runtime home, config, log, supervisor connectivity, wire version,
config freshness, and adapter presence. By default it never starts a supervisor;
a stopped supervisor is a warning ("installed"), not a failure. --start launches
one and probes it. --probe additionally spawns every available backend, completes
ACP initialize and session/new, and closes it; this can be slow and may exercise
provider authentication. --probe implies --start. Exits 1 only when a required
check fails.`,
    whoami: `hlao whoami

Report this shell's role, session id, parent, root, depth, and backend from the
HLAO_* environment. An operator shell has no session id.`,
    down: `hlao down [--force]

Ask the supervisor to close all sessions and exit. This ends every live session
and loses its in-memory history; export anything you need first with
"hlao read <id> --since 0 --json". --force kills the process and removes the
lock when the normal path is not available.`,
  };
  return help[command] ?? fullHelp();
}
