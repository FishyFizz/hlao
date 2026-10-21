import { SESSION_FIELD_NAMES } from "../render.js";
import { fullHelp } from "./overview.js";

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
  --mode ID              provider mode (operator shell only; see "hlao mode")
  --model VALUE          select the model category of provider config options
  --config KEY=VALUE     set a provider config option (repeatable)
  --parent SESSION       spawn under another session in this instance
  --env K=V              extra environment for the adapter (repeatable)
  --no-skill             omit the HLAO skill pointer from the first prompt
                         (the skill file and $HLAO_SKILL are still present)
  --idempotency-key KEY  reuse the session produced by an earlier spawn with
                         the same key instead of spawning again
  --resume PROVIDER_ID   reopen a provider session with ACP session/load
                         instead of creating a new one. Pass the provider id
                         an earlier spawn printed, and its original --cwd.
  --fork PROVIDER_ID     copy a provider session with ACP session/fork into a
                         new session. The source is untouched; the copy's
                         history is replayed when the backend supports loading.

The provider mode is the permission policy. For a new session, with no --mode,
a spawn uses backends.<name>.defaultMode from config and then the provider's
own default. A resumed or forked session keeps the provider's persisted mode.
An agent-spawned new session always takes the backend default; a caller may not
pass --mode. The spawn result includes the handle, label, provider id, effective
mode, and cursor. The first message id is printed when a message is sent. Text passed
as a positional or --prompt is visible in process listings and shell history;
use --stdin or --prompt-file for secrets.

The HLAO id is an alias for this supervisor's lifetime. The provider id is the
durable handle: --resume replays the provider's history into the new event log
(those events carry replay: true), and the interrupted turn is not replayed, so
re-issue the prompt. If a live session already holds that provider id, --resume
returns that session instead of opening a second adapter.

--fork creates a new provider session from a copy of the given one. The source
keeps running unchanged; the fork gets its own provider id. --resume and --fork
cannot be combined. A backend that does not advertise the ACP capability is
refused rather than silently ignored. A resume or fork keeps the provider's
persisted mode; backends.<name>.defaultMode applies to new sessions only.`,
    adopt: `hlao adopt <backend> <provider-id> [options]

Take an existing provider conversation into this HLAO instance as a new HLAO
session. This is the recovery path after a supervisor restart and the adoption
path for a conversation created outside HLAO.

The provider session is loaded with ACP session/load; its history is replayed
into the new event log with replay: true. The interrupted turn is not replayed,
so re-issue the prompt. The new session gets a new HLAO id, name, parent/root,
and environment. The old HLAO id (if any) is not restored: the provider id is
the durable handle, and this command creates a new attachment to it.

Options:
  --cwd DIR              the provider session's cwd; looked up when omitted
  --name LABEL           operator label for the new HLAO session
  --parent SESSION       lineage for the new session (default: the caller for an
                         agent, a root for an operator shell)
  --no-skill             omit the HLAO skill pointer from the first prompt
  --fork                 copy the provider session instead of attaching it
                         (the source keeps running; the copy gets a new id)

The provider catalog is read first when the supervisor advertises
backends.sessions. If the id is found, its cwd is used and a mismatched --cwd
is refused. If the catalog cannot be read, pass --cwd explicitly. A provider
session already live in this instance is returned as a duplicate; no second
adapter is opened. HLAO cannot detect another client or another HLAO home
driving the same provider session; use --fork when the source must stay
untouched.`,
    provider: `hlao provider sessions <backend> [--cwd DIR | --all] [--cursor CURSOR]

List the provider's own session catalog through ACP session/list. These are
provider conversations, not HLAO sessions. A live join marks rows this HLAO
instance currently drives; a provider-only row can be adopted with
"hlao adopt <backend> <provider-id>".

Options:
  --cwd DIR      filter to one absolute working directory (default: current)
  --all          read the catalog across working directories
  --cursor C     continue from a previous page's next cursor

The read starts a short-lived adapter process; it does not create an HLAO
session or a provider conversation. A backend that does not advertise
session/list is refused. The supervisor's live table remains the instance-wide
address space.`,
    children: `hlao children [--provider ID | --self]

List the historical spawn receipts for a parent provider id. A receipt is
written when a parent session spawns or adopts a child: it pairs the parent's
provider id with the child's provider id and records the child's backend, cwd,
and name at that moment. The ledger is append-only and lives at
$HLAO_HOME/spawn-ledger.jsonl.

This is the recovery path after a restart, when the HLAO instance is empty and
the HLAO ids are gone. The provider id is the durable handle:
  hlao children --self
  hlao adopt <backend> <provider-id>

Options:
  --provider ID   read receipts for this provider id; no supervisor needed
  --self          resolve this session's provider id, then read its receipts
                  (default inside a session)

A receipt is history, not liveness: the child may have ended. Adoption returns
the live session as a duplicate if one still holds the same provider id. Use
--fork when the source may be driven elsewhere. Malformed or partial lines are
ignored; the ledger never changes the live session table.

The ledger is per HLAO home. A leader that was forked (not resumed) has a new
provider id; read its predecessor's receipts with --provider <source-id>.`,
    send: `hlao send [<id>] [message] [options]

Deliver a prompt. When the target is idle it runs a turn immediately. When it
is mid-turn the default depends on the caller: a session steers the message
into the running turn (ACP steering, when the adapter supports it), while an
operator shell queues it behind the turn. If the adapter cannot steer, the
message is queued either way. A message to your own session always queues: that
is the deferred next-turn form.

Options:
  --steer                always try to inject into a running turn
  --queue                never inject; always queue behind the running turn
  --self                 target this shell's own session (required when <id> is
                         omitted, because the first positional is the message)
  --stdin                read the message from stdin
  --prompt TEXT          message text (alternative to the positional)
  --prompt-file FILE     read the message from a file
  --wait                 wait for the turn that carries this message (for a
                         steered message, the running turn)
  --timeout DUR          bound the wait (0 = no bound)
  --idempotency-key KEY  retry safely: a repeat with the same key returns the
                         original message id and never enqueues twice

A timeout exits 2 and leaves the turn running. Every send returns a message id
(msg-…) that events and queue entries carry. Text passed as a positional or
--prompt is visible in process listings and shell history; use --stdin or
--prompt-file for secrets.`,
    read: `hlao read [<id>] [options]

Read orchestration state plus a bounded page of typed events.

Options:
  --self                 target this shell's own session
  --since N              forward: events with seq > N (omit for the newest page)
  --before N             backward: events with seq < N (exclusive with --since)
  --limit N              page size, 1..1000 (default 100)
  --type TYPE            keep only this event type; repeatable
  --turn N               keep only this turn
  --grep TEXT            case-insensitive literal over one event's type and data
  --regex                interpret --grep as a case-insensitive regular expression
  --context N            include up to N retained neighbors around each match
                         (0..20; --limit still bounds matches)
  --after TIME           keep events at or after TIME
  --until TIME           keep events strictly before TIME (not with --follow)
  --fail-on-error        with --follow, exit 3 when the session failed
  --verbose              human mode: include bounded tool input/output
  --raw                  with --json, include original ACP payloads; in human
                         mode, reveal adapter stderr and command updates
  --timestamps           show full ISO timestamps instead of HH:MM:SS
  --follow               keep reading, then one-shot wait, until the session
                         ends or you press Ctrl-C; --json emits one page per line
  --jsonl                emit one event object per line (not with --json/--out)
  --jsonl-page           with --jsonl, emit a page metadata line before events
  --out FILE             also write this page's JSON result to FILE

The response reports earliestRetainedSeq, lastSeq, nextSeq, nextBefore,
hasMore, and truncated. Filters are applied before the page limit, and cursors
advance past non-matching events. Tool payloads are omitted unless
--raw/--verbose; --grep does not search private payloads without --raw.
With --context, matchedSeqs lists the events that matched and the rest of the
page is their neighbors; cursors still advance by matches, so a neighbor may
repeat on the next page.

Agent text is streamed as chunks. Human output joins adjacent chunks, but grep
matches one event at a time, so a phrase split across chunks will not match.`,
    get: `hlao get [<id>] [--brief]

Print one session's orchestration state without reading events: status, turn,
queue, settlement, provider title, agent name/version, plan, compaction,
provider mode, config options, usage, the pending permission queue, and
lineage. --brief prints only the header. Inside a session, omit <id> or pass
--self.`,
    find: `hlao find TEXT [--all] [--type TYPE]... [--max N] [options]

Search events across sessions. It is a bounded client loop: list sessions, then
page each transcript with read --grep. By default only live sessions are
scanned; --all includes retained closed/failed ones.

  --type TYPE   keep only these event types; repeatable
  --max N       stop after N matches (1..10000, default 1000)
  --after TIME  keep events at or after TIME
  --until TIME  keep events strictly before TIME
  --regex       interpret TEXT as a case-insensitive regular expression
  --context N   show up to N neighboring events around each match (0..20)

Each match prints its time, session label, seq, type, and a one-line snippet.
The summary separates "stopped at --max" from "page cap reached" and names
sessions that could not be read. Exit 0 with "no matches" when nothing matched.`,
    export: `hlao export [<id>] [options]

Export the session's full retained history, paging until no events remain.
This is the supported recovery path before "hlao down"; "read --out" saves one
bounded page by design.

Options:
  --self                 target this shell's own session
  --all                   export every session; requires --out DIR
  --since N              start after this seq (default 0: all retained events)
  --raw                  include original ACP payloads
  --jsonl                one event object per line (not with --json)
  --out FILE|DIR         write to FILE; with --all, a directory

Without --out the JSON result is written to stdout, so redirecting it is safe.
The result reports count and whether history was already truncated; human
output names the file and the event count.

With --all, each session is written as <id>.json (or <id>.jsonl) plus
manifest.json, which records per-session counts, truncation, and failures.
The command refuses to overwrite an existing export in the directory. It exits
1 when any session failed; the manifest is still written.`,
    watch: `hlao watch [--all | --root SESSION] [--type TYPE]... [--grep TEXT]
             [--regex] [--verbose] [--json]

Follow every live session in one merged timeline. Events from different
sessions are interleaved in delivery order and labelled with the session's
name (or provider title, first prompt, then id). New sessions are attached
when the supervisor announces them; a session that disappears is reported.

  --all          also include retained closed/failed sessions (they emit
                 nothing new)
  --root S       only that session's root subtree
  --type TYPE    keep only these event types; repeatable
  --grep TEXT    case-insensitive literal over type and event data
  --regex        interpret --grep as a case-insensitive regular expression
  --verbose      append a bounded data preview to each line
  --json         one JSON object per line: session.joined, event, or
                 session.removed

History is not replayed: watch starts at each session's current cursor. Use
"hlao read" or "hlao export" for retained history. The supervisor owns no
timer; the CLI holds the subscription and reconnects with its cursors if the
stream drops. JSON event lines carry {kind:"event", sessionId, event}.`,
    usage: `hlao usage [--root SESSION] [--since TIME] [--until TIME]
            [--group session|root|model]

Report fleet usage. Without a window, this projects the latest usage snapshot
every session already carries. With --since/--until, it reads the latest
"usage" event per session inside the window (where the log still retains it).

  --root S       keep only that session's root subtree
  --since TIME   start of the window
  --until TIME   end of the window
  --group G      session (default), root, or model

Cost is additive and is totalled per currency. Tokens are context-window
snapshots, never summed; grouped views therefore show sessions and cost only.
This is observation, not a budget: a caller stops work with wait/read loops.`,
    wait: `hlao wait [<id>...] [options]

One-shot await on orchestration state. It never re-arms.

Options:
  --self                 target this shell's own session
  --any                  with several ids, resolve on the first to satisfy
  --all                  with several ids, resolve when every one satisfies
  --until idle|settled|permission|exit|change   default idle
  --since N              baseline for "change" (single id only; default: now)
  --type TYPE            with "change": wake only on this event type; repeatable
  --grep TEXT            with "change": wake only on a matching event
  --timeout DUR          bound; default from config (30m), 0 = no bound
  --fail-if-failed       exit 3 when a waited session ended failed
  --root SESSION         wait on that job's sessions (SESSION must be the root)
  --tree <id>            wait on this session's subtree (it and descendants)
  --status S[,S]         wait on sessions in these states
  --idle DUR             wait on sessions settled for at least DUR
  --except-self          exclude this shell's session from a selector

Selector flags are a client assembly over list + wait; apart from the
--tree <id> form they take no positional ids, and a wait is limited to 100
targets by the wire.

Conditions:
  idle        the historical completion condition: no runnable turn. It resolves
              when the session settles, parks at a permission gate, or ends.
              A session that ends before it becomes idle is unsatisfied (exit 3).
  settled     the explicit completion condition: settled, permission, or exit.
              Termination counts as completion (exit 0).
  permission  operator input is pending: one or more permission requests
              (answer with permit) or a provider question (answer with elicit).
  exit        the session is terminal.
  change      a new event matches --since/--type/--grep.

An input stop is an actionable completion for idle and settled: there is no
runnable turn, and the output names "settled (permission)" with the pending
permission or question. Use --until permission when the gate itself is the
event you want.

With several ids, the JSON result includes per-target results in request order;
a target still waiting when the wait resolves is reported as "pending". A
timeout exits 2. A terminal session before the condition is unsatisfied and
exits 3, except for settled and exit, where termination is completion.`,
    list: `hlao list [--all] [--cwd DIR] [--wide] [--usage] [--tree] [--watch]
             [--fields LIST] [--no-cwd] [--compact]

List sessions in this HLAO instance. A session is shown by id and name; every
session in the instance is addressable by every caller. The footer reports the
instance count, and a view with a known caller marks that session with *.
--all includes sessions that have closed but are still retained for reading.

Filters: --status S[,S], --backend NAME, --root SESSION, --mine (the caller's
own root subtree, from HLAO_ROOT_ID/HLAO_SESSION_ID), --name TEXT, --pending
(any pending permission or question), --cwd DIR (exact working directory), and
--cwd-prefix DIR (subtree). Filters
never change the instance counts in the footer. --sort created|activity (human
default: activity). --wide adds BUSY, REQUESTER, MODEL, AGENT, MODE,
PENDING, and EXIT; --usage adds USAGE/COST and a per-currency footer total; --tree
groups and indents by lineage. --watch redraws every --interval DUR (default 2s; JSON
emits one result per line) until Ctrl-C.

Output width: in a TTY, columns are dropped (CWD first) and long cells are
shortened to fit the terminal. Piped output keeps the full table. --no-cwd
drops CWD explicitly; --fields a,b,c selects columns in your order (known
columns: ${SESSION_FIELD_NAMES.join(", ")}). --compact applies to --json and
omits modes and configOptions from list items; "hlao get" still returns them.`,
    cancel: `hlao cancel [<id>] [--keep-queue] [--wait]

Request ACP session/cancel for the active turn. By default every queued message
is discarded as well; --keep-queue stops only the active turn and lets the next
queued message run. The session survives. Inside a session, omit <id> or pass
--self. --wait then waits for the cancelled sessions to settle (exit 2 on
timeout).

Bulk mode uses the same selectors as close: --root SESSION (the job root),
--tree <id> (that session and descendants), --status S[,S], --idle DUR,
--except-self. Apart from --tree <id>, selector flags take no positional id.`,
    close: `hlao close [<id>] [--force] [--tree] [--forget]
hlao close --idle DUR | --status S[,S] | --root SESSION [--dry-run] [--forget]

Close a session. ACP session/close is attempted when advertised, then the
adapter process is terminated. --force skips the protocol close. --tree closes
this session's descendants first (a CLI assembly over list + close). Inside a
session, omit <id> or pass --self.

Bulk mode selects sessions instead of naming one: --idle matches idle sessions
whose last activity is older than DUR; --status matches states; --root matches
a whole job and must name the job root (a child id is refused; use --tree for
its subtree); --except-self excludes the caller. --dry-run prints the targets
and actions without changing anything. --forget removes a terminal session from
the table (retention is otherwise one hour); a session with retained
descendants must have them forgotten first. Closing discards queued messages
and, once retention ends, in-memory history.`,
    permit: `hlao permit [<id>] --allow|--deny|--option ID [--always] [--request ID]

Answer one of the session's pending provider permission requests. This is
operator-only: a caller with HLAO_SESSION_ID is refused with operator_only and
must report the blocker. --allow picks the provider's allow_once (else
allow_always), --deny picks reject_once (else reject_always), and --option
names one exactly. The option must be offered.

--always is a provider option selector, not a policy change:
--allow --always selects allow_always and --deny --always selects reject_always.
If the request does not offer that kind the command fails with bad_option; it
never falls back.

--request ID answers one request. With more than one pending and no --request,
the command is a bad_request that names the request ids. --all-pending answers
every pending request; --root SESSION (the job root), --tree <id> (that session
and descendants), --status, --idle, and --except-self narrow the set. Apart from
--tree <id>, selector flags take no positional id. A request with no matching
option is reported and does not stop the others.`,
    elicit: `hlao elicit [<id>] [--accept key=value ... | --decline | --cancel]

Answer a provider question (ACP form elicitation), such as Claude Code's
AskUserQuestion. Without an action flag, print the pending question and its
form fields; a session with no pending question is an error.

--accept sends schema-shaped content. Each positional is key=value; values
parse as JSON when possible, so strings, numbers, booleans, and string arrays
work ("question_1=[\\"a\\",\\"b\\"]"). --decline answers with no content, and
--cancel withdraws the question (the provider aborts the tool call). An
elicitation is not a permission: the operator-only permit relay never answers
it, so it always waits for an operator or a delegated session. Inside a
session, omit <id> or pass --self.`,

    mode: `hlao mode [<id>] [modeId]

Read or switch the provider's native mode. The mode is the permission policy:
the provider decides what its modes mean, and HLAO does not normalize them.

Without modeId: print the current mode and the available modes. Any caller may
read, including its own with --self.
With modeId: request session/set_mode and report the result. Setting a mode is
operator-only; an agent caller is refused with operator_only.

Bulk set (operator-only, replaces "hlao policy" bulk):
  hlao mode --root SESSION <mode>     the whole job (SESSION must be its root)
  hlao mode --tree <id> <mode>        that session and descendants
  hlao mode --status S[,S] <mode>     sessions in those states
  hlao mode --idle DUR <mode>         sessions settled for at least DUR
Apart from --tree <id>, selector flags take no positional id.`,
    option: `hlao option [<id>] [key value]

Read or set a provider-advertised session config option (model, reasoning
effort, and adapter-specific settings). Values shown with "current" come from
ACP session/new and config_option_update.

Without key value: print every option and its selectable values.
With key value: request session/set_config_option. Boolean options accept
true/false. Inside a session, use --self or --self <key> <value>.`,
    queue: `hlao queue [<id>] [--self]
hlao queue drop [<id>] <position> [--self]
hlao queue drop <id> --id <message>

List queued prompts with sender, age, message id, and a bounded text preview,
or drop one position (1 is the next message to run) or one message by id.
Dropping settles that caller as cancelled. Inside a session, omit <id> or pass
--self. Cancel with --keep-queue stops only the active turn.`,
    rename: `hlao rename <id> <name> [--clear]

Give a session an operator-facing name. A unique name can then be used anywhere
a session id is accepted. Duplicate names resolve as ambiguous. --clear removes
the name. Inside a session, use --self <name> (or --self --clear).`,
    agents: `hlao agents [--cwd DIR]

Show built-in, user, and project backends with their source, readiness, and
the operator's defaultMode when configured. Reads configuration locally so it
works without a supervisor; the same view is available to any client as the
wire method backends.list. Environment values are never printed, only their
names.`,
    status: `hlao status [--start]

Probe the supervisor without starting one and report pid, version, uptime, live
sessions, wire protocol version, capability count, config errors, and whether
the config on disk is fresher. Exits 1 when nothing is running. --start
autostarts the supervisor first.`,
    logs: `hlao logs [--lines N] [--follow] [--raw]

Read the supervisor's diagnostic log directly; no supervisor is needed. The
default is the last 50 lines; --lines 0 prints the whole file. --follow polls
for appended lines until Ctrl-C. Human output strips ANSI, C1, and bidi
controls; --raw prints the line untouched. With --json, a plain read returns
{"path","lines"}; --follow emits one {"path","line"} object per line.`,
    config: `hlao config show|path|validate

Local, non-mutating configuration inspection.

  show       effective values and backends; prints permissionTimeoutMs,
             maxPendingPermissions, and each backend's defaultMode; backend env
             values are redacted
  path       the user config path (whether or not it exists)
  validate   parse and validate the file; exits 1 on an invalid config.
             A removed permissionPolicy is reported with the defaultMode
             migration, not a generic unknown-key error.`,
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
    skill: `hlao skill [path | --path] [--json]

Print the agent-facing HLAO skill: what a spawned session is, the moves, the worker loop, and
the rule that the prompt is the context channel (verbatim or by reference; no invented state).
Spawned sessions get its path in $HLAO_SKILL and a one-line pointer in their first prompt.

  --path     print the home copy's path instead of the text
  --json     return {name, version, path, packagedPath, text}`,
    whoami: `hlao whoami

Report this shell's role, session id, parent, root, depth, and backend from the
HLAO_* environment. An operator shell has no session id.`,
    down: `hlao down [--force] [--export DIR]

Ask the supervisor to close all sessions and exit. This ends every live session
and loses the in-memory history of live and retained sessions; export anything
you need first with "hlao export <id> --out FILE".

  --export DIR   export every session and manifest.json to DIR before stopping.
                 If any session fails to export, shutdown is refused.
  --force        kill the process and remove the lock when the normal path is
                 not available. With --export, the export must still succeed.

"down" is also the upgrade escape hatch: it may use the legacy connection path
to stop a live supervisor of an older wire major when that supervisor still
answers "sessions.list" and "supervisor.shutdown". If it cannot, stop it with
the old CLI first. Other commands report version_mismatch instead of
replacing it.

--dry-run reports what would be exported and closed without changing anything.`,
  };
  return help[command] ?? fullHelp();
}
