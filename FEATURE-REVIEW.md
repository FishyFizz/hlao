# HLAO 0.1.0 — Feature & Usage Review

**Reviewed:** 2026-10-19  
**Version:** 0.1.0  
**Platform:** Windows 11, Node 26.8.1  
**Method:** source and docs read, full test suite (`npm test`: 62/62 pass), and live CLI probes against the bundled scripted ACP agent (`tests/fixtures/fake-acp-agent.ts`) in isolated `HLAO_HOME`s. No real provider turn was run, to avoid spending provider credentials; real-adapter behavior is taken from `docs/context.md`.

**Scope limits:** this is a feature/usage review, not a code-correctness audit. I did not exercise real Claude/Codex authentication or turns, did not benchmark performance, and did not attempt a security-boundary assessment. Cross-platform observations are from source and the CI matrix; the live probes were on Windows 11.

**One-line verdict:** The substrate is disciplined and the thesis is visible in the code; the operator experience is not yet 0.1-complete. HLAO currently behaves like a good protocol client with a thin CLI, not like an orchestration surface someone can live in for an afternoon with ten sessions.

---

## Executive summary — the twelve things that hurt most

1. **Session names are decorative, not handles.** You can name a session `build-worker`, see it in `list`, then `hlao wait build-worker` fails with “no session matching.” Only random six-character IDs and prefixes work.
2. **Eviction is silent on the default read path.** A tail `read` after events have been evicted reports `truncated: false` and no human warning. Only `read --since 0` warns. README claims “evictions are reported … never silent”; for the common path, that is false.
3. **`wait` returns success when the session died.** `wait --until idle` (or `permission`, or `change`) on a crashed session exits `0` with “is failed.” A monitoring script that checks exit codes treats a dead worker as a successful check.
4. **A child cannot message its parent.** `PRODUCT.md` says bounded ignorance is actionable by “ask the parent,” but the supervisor forbids every call from a child to its parent as “outside the caller’s scope.” The child knows its parent’s handle and cannot use it.
5. **Long-running waits are opaque.** `spawn --wait` does not print the session handle until the first turn ends (3.2 s in a test; 30 minutes in real use), so you cannot attach from another terminal. `send --wait` is silent for its entire wait. There is no `read --follow`.
6. **Configuration is loaded once and never reloaded.** After editing `~/.hlao/config.json`, `hlao agents` and `hlao doctor` still report the running supervisor’s stale view. Adding a backend requires `hlao down`, which closes every session.
7. **There is no `status` or `logs`, and `doctor` has side effects.** `doctor` and even `agents` autostart a detached supervisor in a fresh home. “Backends 2/2 ready” means the adapter command resolves, not that it starts, handshakes, or has provider authentication (the project’s own context records Codex returning `403`).
8. **Human `read` is second-class.** It shows no event timestamps and no tool input/output — only tool titles and statuses. `--raw` in human mode still does not show tool payloads. Meanwhile `--json` returns `rawInput`/`rawOutput`/`content` even without `--raw`, contrary to the CLI contract.
9. **`list` is not an orchestration dashboard.** It is a flat table with no scope indicator, no tree/lineage, no filters, no policy/mode column, no pending-permission detail, and no turn duration. A parent sees two rows and an operator sees five; the output looks identical. Separately, the `read` header keeps showing a dead PID for failed sessions and omits their exit code.
10. **There is no live permission-policy control, and audit attribution is wrong.** Policy can be set only at spawn; `permit --always` requires a pending request and can only move to `allow`. Events hardcode `by: "operator"` even when an agent answered, and `prompt.sent` has no sender at all.
11. **There is no model or provider-config control.** ACP v1 supports `session/set_config_option` and emits `config_option_update`, but HLAO exposes only permission modes. Claude/Codex users will look for `--model`, reasoning effort, and approval policy on day one.
12. **Sessions accumulate, queues are opaque, and history is fragile.** No idle cleanup, no bulk close, no queue contents or sender, no keep-queue cancel, no resume after an adapter crash, and no transcript export. `down` does not warn that history is lost.

---

## What is genuinely strong

This is not a rewrite recommendation. The core is worth keeping:

- The five primitives are small and honest: `spawn`, `send`, `read`, `wait`, `list`.
- `wait` is one-shot; there is no recurring timer in `src/`.
- Reads are cursor-addressed and bounded, with typed events and raw ACP payloads on request.
- Identity is generated before the adapter process starts and injected as `HLAO_*`; scope is enforced in the supervisor.
- JSON and human modes share semantics; exit codes distinguish success, error, and bounded-wait timeout.
- Permission requests are visible state, not a hidden callback; provider modes are exposed separately.
- The error taxonomy is stable, the lock recovery is careful, and Windows tree-kill behavior is considered.
- The docs are unusually good: `PRODUCT.md`, `STACK.md`, ADRs, contracts, and four acceptance assemblies.
- The test suite is green and exercises the real CLI → supervisor → scripted ACP agent path.

The critique below is therefore mostly about **affordances around the primitives**, not about replacing them.

---

## Feature scorecard

| Area | What exists | What a user will expect | Gap |
|---|---|---|---|
| Addressing | ID or unambiguous prefix | Name, self-default, `last`, rename, tags | Large |
| Visibility | Flat list, read header | Tree/root grouping, filters, scope indicator, pending/turn detail | Large |
| Observability | Bounded read, JSON | Follow/tail, timestamps, tool I/O, search/filter, export | Large |
| Control | spawn/send/cancel/close | Policy change, queue control, interrupt, bulk/idle cleanup | Medium–large |
| Permissions | Pending state, permit, modes | Live policy switch, attribution, dashboard | Medium |
| Provider control | Permission modes | Model, reasoning effort, config options | Large |
| Operations | Autostart, doctor | Status, logs, reload, restart, non-mutating doctor | Large |
| Config | User/project backends | Show/validate/reload, project policy/timeouts, interpolation | Medium–large |
| Agent ergonomics | `HLAO_*` env, scoped view | Self-default, parent channel, name env, CLI on PATH | Medium–large |
| Resilience | Closed retention, graceful down | Resume, export, loss warnings | Large (design-sensitive) |
| Polish | Mostly good | Parser strictness, rendering consistency, help accuracy | Medium |

---

## P0 — Blocking usability issues

“P0” here means **a real user will hit this in the first week**, not that the process crashes. P0-14 and P0-15 are design-sensitive; the rest are straightforward affordances.

Each item lists **what a user expects**, **what happens**, **evidence**, **why it matters**, and the **smallest useful fix**. Tags: `[CLI-only]`, `[supervisor]`, `[product decision]`, `[design tradeoff]`.

### P0-1. Session names cannot be used as handles `[supervisor]`

**Expect:** `hlao read build-worker`, `hlao wait build-worker`, `hlao send build-worker "..."`.

**Actual:** `--name` is stored in `SessionView.name` and rendered in `list`/`read`, but resolution only accepts an exact ID or an ID prefix. A unique name is not found.

```console
$ hlao list
ID      NAME          BACKEND  STATUS  TURN  QUEUED  AGE  CWD
ss164y  crasher       fake     failed  1     —       now  D:\Fizz\Dev\HLAO

$ hlao wait crasher --until exit
hlao: no session matching "crasher"
# exit 1
```

**Why it matters:** Six random characters are not a human handle. In practice, users will name workers (`build-worker`, `reviewer-2`) and then paste IDs into every command. Names also disappear from command results, so scripts can only carry IDs. This is the single largest everyday friction.

**Fix:** Resolve exact names within the caller’s visible scope, using the live session table (no registry). If a name is duplicated, return the existing `ambiguous_id` shape with candidates. Add `hlao rename <id> NEW`. Include the name in `spawn`/`send`/`cancel`/`close`/`permit`/`mode` output. Optionally enforce name uniqueness at spawn within a root. Add `HLAO_NAME` and show it in `whoami` if the agent should know its own label.

**Effort:** S–M.

---

### P0-2. Inside a session, the handle is not optional `[CLI-only]`

**Expect:** From inside a spawned session, `hlao read`, `hlao send "..."`, `hlao wait --until permission`, and `hlao close` act on the current session.

**Actual:** Every session-targeting command requires an explicit ID. The documented worker loop is therefore:

```bash
hlao send "$HLAO_SESSION_ID" "Check the log again." --wait --timeout 20m
hlao read "$HLAO_SESSION_ID" --since 42
hlao wait "$HLAO_SESSION_ID" --until permission --timeout 10m
```

**Why it matters:** The injected identity exists specifically so a session can manage itself. Making the caller repeat it is noise, a typo opportunity, and a readability tax in every agent prompt. It also makes `hlao` commands less natural than they should be for the primary user.

**Fix:** If the ID positional is omitted and `HLAO_SESSION_ID` is set, default to self for `read`, `send`, `wait`, `cancel`, `close`, `permit`, and `mode`. Add `--self` for explicitness. In an operator shell with no ID, keep the current usage error. Do not change `list` (its scope is already self-and-descendants).

**Effort:** S. Pure CLI.

---

### P0-3. A child cannot ask its parent — contradicting `PRODUCT.md` `[product decision]`

**Expect:** `PRODUCT.md` says a participant’s bounded ignorance is actionable: “read the ledger, ask the parent, spawn an investigator.” A child knows `HLAO_PARENT_ID`.

**Actual:** The parent is outside the child’s scope, so `send`, `read`, and `wait` all fail:

```console
$ HLAO_SESSION_ID=<child> hlao send <parent> "hello parent"
hlao: session <parent> is outside the caller's scope
# exit 1
```

**Why it matters:** This is a direct contradiction between the product thesis and the shipped behavior. Delegation becomes strictly one-way: a parent can question a child, but a child cannot report a finding, ask for a missing fact, or say “this task is impossible” without waiting for the parent to poll. The child can see the parent’s handle but cannot use it — a visible boundary with no move, which is precisely the failure class the product claims to solve.

**Options:**

1. **Allow `send` to the direct parent only.** Do not allow `read`, `wait`, `cancel`, `close`, or `permit` on the parent. This creates an upward reporting channel without granting halt authority. Record the sender so the parent sees who spoke.
2. **Add a narrow `hlao notify-parent`** that appends a message to the parent’s event stream without starting a turn. This is a new primitive and needs more thought.
3. **Keep the scope rule and amend `PRODUCT.md`.** If upward asks are deliberately impossible, remove “ask the parent” from the claimed actionable moves and document the shared-file workaround. Do not leave the contradiction.

**Recommendation:** Option 1, with explicit product sign-off. It preserves the authority model (visibility still does not include ancestors for reads) while making the one move the docs already claim possible.

**Effort:** M.

---

### P0-4. `wait` can report success for a dead session `[supervisor + CLI contract]`

**Expect:** `wait --until idle` exits `0` only when the session reached `idle`; `--until permission` only on a pending permission; `--until change` only on a change.

**Actual:** A terminal session resolves any wait with `reason: "exit"` and `satisfied: false`, but the CLI returns exit `0` for every non-timeout reason:

```console
$ hlao wait ss164y --until idle --timeout 1s
ss164y is failed (waited 0ms)
# exit 0

$ hlao wait ss164y --until permission --timeout 1s
ss164y is failed (waited 0ms)
# exit 0
```

The JSON does contain `satisfied: false`, but the human output and exit code do not distinguish “the condition was met” from “the session died first.”

**Why it matters:** The README itself recommends `wait → read → judge → wait` loops. A loop that checks only the exit code — the normal shell idiom — treats a crashed worker as a successful idle/permission check and may spin or proceed with a stale plan. `wait --until exit` legitimately returns `0` for a failed session; the other conditions should not.

**Fix:** Return a distinct nonzero code (for example `3`) when `reason === "exit"` and `until !== "exit"`. Keep `0` for `--until exit`. Print the exit code/signal in the human result. Update `contracts/cli.md` and add tests for all four conditions against a crashed session.

**Effort:** S.

---

### P0-5. Eviction is silent on the default read path `[supervisor + CLI]`

**Expect:** If events have been evicted, every read says so.

**Actual:** With `maxEventsPerSession: 3`, the tail read returns only `#8–#10`, sets `truncated: false`, and prints no warning. Only `read --since 0` sets `truncated: true`.

```console
$ hlao read <id>
#8  tool › Read the prompt → completed
#9  usage › 42/200000 tokens
#10 — turn 1 ended: end_turn —

$ hlao read <id> --json
{ "first": 8, "last": 10, "earliestRetainedSeq": 8,
  "truncated": false, "hasMore": false }
```

The event log’s `read()` sets `truncated` only when an explicit `since` precedes the earliest retained event. The human renderer never prints `earliestRetainedSeq`, so a tail reader cannot know that `#1–#7` ever existed.

**Why it matters:** README says “Evictions are reported with `truncated`, never silent.” For the most common read (`read <id>`), they are silent. Long sessions with 5,000-event/16 MB retention will hit this routinely, and the user will review an incomplete history believing it complete.

**Fix:** Set `truncated` (or add an explicit `evicted` count) whenever `earliestRetainedSeq > 1`, including tail reads. Render “history starts at #8 (7 events evicted)” unconditionally when applicable. Add a unit test for the tail path — the current test only covers `since: 0`.

**Effort:** S.

---

### P0-6. No live follow/tail; long waits are opaque `[CLI-only for most of this]`

**Expect:** `hlao read --follow`, `hlao list --watch`, `hlao logs --follow`, and some progress while waiting.

**Actual:** `read` prints one bounded page and exits. `spawn --wait` prints nothing until the first turn ends; in a 3.2-second scripted run the handle appeared only at the end:

```console
$ time hlao spawn fake "slow spawn" --env FAKE_MODE=slow --env FAKE_DELAY_MS=3000 --wait
spawned 6qhy86 (fake) in D:\Fizz\Dev\HLAO
working…stopped: end_turn
— turn 1 ended: end_turn —
# elapsed ~3.2s; the ID was unavailable for the entire wait
```

`send --wait` is similarly silent for up to `sendWaitTimeoutMs` (30 minutes by default). There is no way to watch a long turn from the same command.

**Why it matters:** Watching a long-running job is the primary use case. Without a follow mode, every user writes the same shell/Node loop: read from a cursor, sleep/wait, read again. That loop is exactly the assembly the design says is acceptable — so it should exist as a documented CLI affordance. `spawn --wait` additionally hides the handle needed to attach from another terminal, defeating the “operator plus agent” workflow.

**Fix:**

- **`read --follow`**: a CLI-side loop over the existing primitives. Read from a cursor, print new events, then `wait --until change --timeout 2s` (a one-shot await), repeat. Stop on a terminal state, on `--until`, or on Ctrl-C. Add `--format jsonl`. This respects ADR 0002: no supervisor stream, no recurring timer, and the caller owns the loop.
- **`list --watch`**: the same CLI-side loop, redrawing the table on change.
- **`spawn --wait` early handle**: compose the same semantics in the CLI: call `spawn` without the prompt, print the ID/name, then call `send --wait` with the prompt. This preserves turn numbering and makes the handle available immediately. Alternatively, add a supervisor “spawned” ack before the first-turn wait.
- **Progress**: after ~2 seconds of `send --wait`/`spawn --wait`, write a line to stderr: “waiting for turn N; queue position M; Ctrl-C detaches, the work continues.” Do not print on non-TTY unless `--progress`.

**Effort:** M, mostly CLI.

---

### P0-7. Config is loaded once; diagnostics read the stale supervisor `[supervisor + CLI]`

**Expect:** Edit `config.json`, and the next command uses it. `hlao config show` tells you the effective values.

**Actual:** The supervisor parses the user config at startup and holds it for its lifetime. `hlao agents` and `hlao doctor` ask the running supervisor, so they report the stale configuration. Adding a backend requires `hlao down`, which closes every live session.

```console
$ hlao agents            # fresh home: claude, codex
$ # add a "later" backend to <HLAO_HOME>/config.json
$ hlao agents
claude  builtin  yes ...
codex   builtin  yes ...
# "later" is absent

$ hlao doctor
✓ config: ...\config.json
✓ backends: 2/2 ready (claude, codex)
# the running supervisor never loaded the new file
```

**Why it matters:** Configuration is routine. Making a config change cost every running session is a serious operational defect. Worse, `doctor` says “config ✓” while the process actually serving requests is using different values, so the diagnostic can be confidently wrong.

**Fix:**

- `hlao config show [--cwd DIR] [--json]`: merge built-ins → user → project locally, print effective values, and redact env values (`--show-env` to reveal). `hlao config path` prints the files in use.
- `hlao reload`: a supervisor method that re-reads and validates atomically; applies to new spawns and defaults only; never mutates live sessions. Log the old/new hashes and emit a notice.
- `hlao restart`: `down` + next command, with an explicit warning that sessions and history are lost.
- `agents` should load config locally instead of asking the supervisor; `doctor` should compare the supervisor’s loaded config with disk and warn on divergence.

**Effort:** M.

---

### P0-8. No `status`/`logs`; `doctor` has side effects and overclaims readiness `[CLI + optional supervisor probe]`

**Expect:** A read-only way to see what the supervisor is doing and to read its log. `doctor` should diagnose, not mutate.

**Actual:** `hlao doctor` in a fresh home creates the home and starts a detached supervisor; it even prints “home … (will be created)” and then creates it during the same run. `hlao agents` also autostarts a supervisor although it only needs local config. `doctor` reports “2/2 ready” based solely on the adapter command resolving; it does not start the adapter, check ACP `initialize`, or check provider authentication. The project’s own `docs/context.md` records Codex returning `403 GROUP_NOT_ALLOWED`.

```console
$ HLAO_HOME=<fresh> hlao doctor
! home: C:\...\hlao-review-doctor (will be created)
✓ supervisor: pid 10908 · \\.\pipe\hlao-...
✓ wire: protocol v1 · supervisor 0.1.0
✓ backends: 2/2 ready (claude, codex)
# the doctor started the supervisor
```

**Why it matters:** First-run diagnosis is exactly when a surprising daemon side effect is most confusing. “Ready” is the strongest word in the output and it currently means “the JavaScript entry file exists.” A user can see all green, spawn Claude, and fail on authentication or an adapter handshake. There is also no command to read `<HLAO_HOME>/supervisor.log`; `doctor` only prints its path on failure.

**Fix:**

- **`hlao status [--json]`**: read the lock; if a supervisor is running, probe `hello`; report pid, uptime, version, endpoint, session counts by status, config error, and log path. Do **not** autostart by default; `--start` opts in.
- **`hlao logs [--follow] [--lines N]`**: read `supervisor.log` and `supervisor.log.1` directly, no supervisor required. CLI-side follow loop.
- **`doctor`**: default to no-autostart (or add `--no-start`), and report “supervisor not running” as a warn rather than starting one. Add `--probe` to launch each available backend, complete ACP `initialize`, read capabilities, and close; make it opt-in because a probe may require provider credentials or have side effects. Show adapter package versions and protocol version. Add `--cwd` so a project config can be checked.
- **`agents`**: load config locally; no supervisor needed.

**Effort:** S–M.

---

### P0-9. Human `read` is second-class; JSON leaks raw tool I/O `[CLI]`

**Expect:** When reviewing what an agent did, see when it happened and what the tools actually received/returned.

**Actual:** Human `read` shows no timestamps at all; tool lines show only title, kind, and status. `--raw` in human mode reveals stderr and command-list churn, but still not `rawInput`, `rawOutput`, or `content`. The JSON result, by contrast, includes those fields even without `--raw` (only `data.raw` is stripped).

```console
$ hlao read 38g8rj
#5  thinking › considering the prompt
#6  tool › Read the prompt [read]
#7  agent › echo: hello world
#8  tool › Read the prompt → completed
#9  usage › 42/200000 tokens
#10 — turn 1 ended: end_turn —

$ hlao read 38g8rj --raw      # identical tool lines; no input/output
```

The CLI contract says “Original ACP payloads are returned only with `--json --raw`.” `rawInput`, `rawOutput`, and `content` are original ACP payloads and are returned without `--raw`.

**Why it matters:** Debugging an agent without seeing tool arguments and results is guesswork. Requiring `jq` for the basic task of “what command did it run and what came back?” makes the human surface a viewer of the agent’s prose, not its work. The JSON leak is also a privacy/consistency problem: agents consuming JSON get tool payloads (possibly secrets) that the contract says require an explicit flag.

**Fix:**

- Render `at` on each event by default (relative age plus absolute on `--timestamps`).
- Add `--verbose` (or make `--raw` human actually raw): show bounded `rawInput`, `rawOutput`, `content`, and tool `locations`, with a clear truncation marker.
- Strip `rawInput`, `rawOutput`, `content`, and `locations` unless `raw: true`, or rename the flag to `--details` and document exactly what it includes.
- Remove the duplicated permission block: current pending permission in the header and the `permission.requested` event in the stream both render the same options.
- Add an “older events retained from #N” hint (see P0-5).
- Show usage cost when present; the human line currently shows only `used/size`.

**Effort:** S–M.

---

### P0-10. `list` is not an orchestration dashboard `[CLI + view fields]`

**Expect:** With several agents, find the blocked one, its parent/root, how long it has been busy, and which policy/mode it uses.

**Actual:** A flat eight-column table: `ID NAME BACKEND STATUS TURN QUEUED AGE CWD`. There is no scope line, no parent/root/depth, no policy, no mode, no pending-permission title, no turn duration, no exit detail, and no filters. `AGE` is `lastActivityAt`, which updates on every event including stderr and usage, so it is not “last meaningful work.”

```console
$ HLAO_SESSION_ID=<parent> hlao list
ID      NAME        BACKEND  STATUS  TURN  QUEUED  AGE  CWD
a58m9e  parent-job  fake     idle    1     —       now  ...
7ewy1s  child-job   fake     idle    1     —       now  ...

$ hlao list
# five rows, exactly the same format; no indication that the first view was scoped
```

A failed session still shows its old `pid` in `read`, with no exit code even though `SessionView.exit` has one.

**Why it matters:** Lineage is a core part of the product, but it is invisible in the primary overview. With ten sessions, the operator cannot answer “which job is this, who spawned it, which are blocked, and which are just slow?” without reading each session individually. The identical scoped/global format is actively misleading to an agent that does not know what it cannot see.

**Fix:**

- Add `--tree` (root → descendants with depth) and a footer line: `scope: operator (5 sessions)` or `scope: session self+descendants (2 visible; siblings not shown)`.
- Add `--status`, `--backend`, `--root`, `--name`, `--pending`, and `--sort activity|created`.
- Add a `--wide` view with `POLICY`, `MODE`, `PENDING`, `BUSY FOR`, `EXIT`; keep the default compact.
- Track `turnStartedAt` (or `lastTurnEventAt`) separately from `lastActivityAt`; show “busy for 4m” rather than an AGE that a stderr line resets.
- In `read` (and any future `list --wide`), for terminal sessions show `exit 3 (signal)` and `endedAt`; do not show a bare PID as if the process were alive. Show `root` and `depth` alongside `parent` in the header.
- Mark the caller’s own session when listing from inside a session.
- `list --watch` is the natural companion (see P0-6).

**Effort:** M, mostly CLI and `SessionView` fields.

---

### P0-11. No live policy control; audit attribution is wrong `[supervisor + protocol]`

**Expect:** Change a live session between `ask`, `allow`, and `deny` without respawning. See who sent, permitted, cancelled, or closed what.

**Actual:** Policy is set only at spawn or via `permit --always`, which requires a pending request and can only move to `allow`. There is no `hlao policy` command. Worse, the event stream hardcodes actor fields:

- `permission.resolved` and `policy.changed` always say `by: "operator"`.
- `mode` always says `by: "operator"`.
- `prompt.sent` records no sender at all.
- `cancel.requested` and `session.closed` record no actor.

A parent session that answers its child’s permission request is recorded as “operator.” An agent that sends a message to a descendant is indistinguishable from the human.

```console
$ hlao permit vysgeg --allow --always
hlao: session vysgeg has no pending permission
# no way to set the policy without a pending request
```

**Why it matters:** Gated sessions cannot be re-gated or denied without losing the session. For multi-agent jobs, the log is the audit trail; if every action is attributed to “operator,” the product’s claim that a job is “reportable” is weakened. The supervisor already receives `callerSessionId`; it is not threaded into these events.

**Fix:**

- `hlao policy <id> [allow|ask|deny]` reads or sets the live session policy; emit `policy.changed` with the real actor. `permit --always` becomes sugar over it.
- Thread `callerSessionId` into `send`, `permit`, `setMode`, `cancel`, and `close`; record `by: <caller id>` or `"operator"`.
- Add `from` to `prompt.sent` and `prompt.queued`; render `you` for the operator and `from <id>` for an agent.
- Add tests that a parent-permitted child shows the parent’s ID, not “operator.”

**Effort:** M.

---

### P0-12. Queue is opaque; cancel is all-or-nothing `[supervisor + CLI]`

**Expect:** See what is queued (text, sender, age), remove one entry, stop the active turn without destroying the backlog.

**Actual:** The view exposes only `queued` depth. `prompt.queued` records `{ position, textLength }` — no text and no sender. `cancel` discards every queued prompt by design (ADR 0005); there is no keep-queue option and no interrupt-and-send.

```console
$ hlao read <id> --json   # prompt.queued data
{"position":2,"textLength":14}
```

**Why it matters:** A parent may send two instructions and then want to stop only the current turn. Today that is impossible: cancel destroys the second instruction. Debugging “what is queued?” is also impossible; you can see a depth but not the work. Queued text is only visible after it is sent or discarded.

**Fix:**

- `hlao queue <id>`: list queued prompts with a bounded text preview, sender, position, and age.
- `hlao queue drop <id> <position>`: remove one queued entry, emitting `prompt.discarded`.
- `hlao cancel <id> --keep-queue`: opt-in, explicit; or a separate `hlao queue clear` and make `cancel` unambiguous. This is a deliberate ADR 0005 deviation, so get product sign-off.
- `hlao send <id> --interrupt "..."`: cancel active + enqueue this message as an assembly; document that the old queue is cleared unless `--keep-queue`.
- Record the sender in queue events.

**Effort:** M.

---

### P0-13. No provider model/config options `[supervisor + protocol]`

**Expect:** `hlao spawn claude --model sonnet`, choose reasoning effort, see current config options, change them live.

**Actual:** Only permission modes are exposed (`spawn --mode`, `hlao mode`). ACP v1 supports `session/set_config_option` and emits `config_option_update`; the code maps the update to a bare `config updated` event but does not store the options in `SessionView` or expose a command.

**Why it matters:** For Claude Code and Codex users, model and reasoning-effort choice is table stakes. “Use Auto permission mode” is exposed; “use Sonnet instead of Opus” is not. This will be one of the first questions a new user asks, and the answer today is “change the provider’s own settings before spawning.”

**Fix:**

- Store `configOptions` in `SessionView`; show them in `read`/`list --wide`.
- `hlao spawn <backend> --config key=value` (and friendly `--model` if the adapter advertises a model option).
- `hlao option <id>` lists config options; `hlao option <id> key value` sets one, with actor attribution.
- Extend the fake ACP agent to advertise config options and add e2e coverage.

**Effort:** M.

---

### P0-14. No resume/recovery; state loss is under-signalled `[design tradeoff]`

**Expect:** After an adapter crash or supervisor restart, either resume the session or export its transcript. At minimum, be warned before losing it.

**Actual:** A failed session is terminal. `read` retains closed/failed output for `retainClosedMs` (1 hour) and then the session is swept. A supervisor restart loses all sessions and history. There is no `hlao resume`, no transcript export command, and `hlao down --help` does not say history will be lost.

**Why it matters:** Long jobs can lose hours of context. ADR 0002 deliberately rejects a durable transcript, and that is a legitimate design choice — but users will still expect recovery, and the loss should be impossible to trigger accidentally. `hlao read <id> --since 0 --json > file` exists, but it is not documented as the export path.

**Fix:**

- Document and test transcript export (`read --since 0 --json` or a small `--out FILE` convenience).
- Add `hlao resume <id>` using ACP `session/load`/`resume` when the adapter advertises it: spawn a new adapter process, load the provider session, keep the same HLAO handle, and continue the event log with a `session.resumed` event. This is warm-host recovery, not cold-host lineage reconstruction; the live table still owns identity.
- Add a loss warning to `down` and `close` help/output, and a `--dry-run`/confirmation for `down` when sessions are live.
- Do not add a durable event store or registry as an authority.

**Effort:** S for export/warnings; L for resume.

---

### P0-15. No idle or bulk cleanup `[CLI assembly]`

**Expect:** `hlao close --idle 1h`, `hlao close --failed`, `hlao close --all --except-self`, or a `prune` command.

**Actual:** Only `close <id> [--tree]` and `down`, which also stops the supervisor. Idle sessions live forever; failed sessions accumulate until the retention sweep; closing many sessions is a shell loop.

**Why it matters:** Long-running use accumulates adapter processes and list rows. The safe operation (close idle sessions, keep the supervisor and active work) does not exist. `down` is too broad and too destructive for cleanup.

**Fix:** A CLI assembly over the existing primitives:

- `close --idle DUR` (no events for DUR; use a meaningful activity timestamp, not stderr churn).
- `close --failed`, `close --closed` (forget), `close --status <s>`.
- `close --root <id>` / `--name <label>`.
- `--dry-run` to print the target list, and `--yes`/interactive confirmation for large sets.

No supervisor timer is needed; the operator or an agent invokes it.

**Effort:** S–M.

---

## P1 — Features users will expect, grouped

The following are not all equal, but each one is a normal expectation for a tool at this stage. “Current” is what exists today.

### Addressing and session identity

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| Rename a session | Names are labels that should be editable | Only `--name` at spawn | `hlao rename <id> NEW` |
| `@last` / `last` | Quick return to the most recent session | None | Alias to most recently active visible session |
| Tags/groups | Organize parallel jobs beyond cwd | None | `--tag` at spawn, `list --tag`; a flat label, not a registry |
| `--parent <id>` on spawn | Operator may attach a worker to another job | Wire supports `parentSessionId`; CLI has no flag | Add the flag with scope check |
| `list --root <id>` | All sessions in one job | Flat list only | Filter by `rootId` |
| Multi-session wait | Wait for any/all of N workers | One ID; extra positionals silently ignored | `wait --any <id...>` / `--all` (one-shot, no timer) |
| Broadcast/announce | `PRODUCT.md` calls announcement `list + send × n` | User writes the loop | `send --tree <id> "..."` or an example helper; keep it an assembly |
| Self-default | See P0-2 | Explicit ID required | CLI default |
| Name in command output | Users identify by name | Only `list`/`read` show it | Include in spawn/send/close/permit/mode |
| `HLAO_NAME` | Agent should know its own label | Not injected | Inject at spawn; show in `whoami` |

### Observability

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| Live follow | Watch long jobs | None | `read --follow` CLI loop (P0-6) |
| `list --watch` | Dashboard for several agents | None | CLI loop; no supervisor timer |
| Timestamps/durations | Know when things happened | JSON only | Human `read` by default; turn duration in `list` |
| Tool input/output | Know what the agent actually did | Titles/status only in human; JSON-only payloads | `--verbose`/`--raw` rendering |
| Event filters | Find the failure in a long log | None | `--type tool.call`, `--turn N`, `--grep TEXT` |
| Backward paging | Read older pages | Forward `--since` only | `--before` or `--page` |
| Transcript export | Save/audit a run | Redirect JSON by hand | `--out FILE` or documented `read --since 0` |
| Usage/cost summary | Know spend/context | Per-event `usage` line only | Aggregate in `SessionView`/`list`; show cost |
| Permission dashboard | Find blocked sessions | Status column only | `list --pending`; pending title/duration |
| Queue contents | Know what is waiting | Depth only | `queue` command (P0-12) |
| Sender attribution | Know who sent a message | None | `from` in events (P0-11) |
| Turn age / stall detection | Distinguish busy from stuck | `lastActivityAt` only | `turnStartedAt`, `busyFor` |
| `read --jsonl` | Pipe events line-by-line | Pretty JSON array | Add a compact stream format |
| `--quiet` | Script without chatter | None | Suppress human hints |

### Control and lifecycle

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| Live policy command | Re-gate/un-gate without respawn | Spawn only / `permit --always` | `hlao policy` (P0-11) |
| Cancel keep-queue | Stop this turn but keep the next | All queue discarded | `cancel --keep-queue` or `queue clear` |
| Interrupt-and-send | Replace a running turn with a new instruction | Manual cancel + send | `send --interrupt` assembly |
| `cancel --wait` | Confirm the active turn actually stopped | Fire-and-return | Wait for `idle`/turn end, bounded |
| Queue drop | Remove one queued message | None | `queue drop` |
| Bulk/idle close | Clean up without `down` | `close <id> --tree` only | `close --idle`, `--failed`, `--root`, `--dry-run` |
| Per-turn timeout | Stop a hung turn | `--timeout` bounds the wait, not the turn | Caller assembly using cancel; document an example |
| Resume | Recover a crashed session | None | ACP load/resume (P0-14) |
| Model/config options | Choose provider behavior | Modes only | `spawn --model`, `hlao option` (P0-13) |
| `send --prompt-file` / `--prompt` | Symmetry with `spawn` | `send` has only `--stdin` | Add both flags |
| Permission answer across sessions | Operator with many gated workers | One at a time | `permit --all-pending` or `wait --any permission` |

### Operations and configuration

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| `hlao status` | See supervisor health | None | Read-only probe; no autostart by default |
| `hlao logs [-f]` | Read the diagnostics log | Path only on doctor failure | Direct file reader + CLI follow |
| `hlao init` / `config init` | Scaffold user or project config | Hand-write JSON | Write an example config with comments/validation |
| `hlao config validate` | Validate without a daemon | Doctor partially | Local parse/merge and exit status |
| `hlao config show/path` | Know effective configuration | Hand-read JSON | Local merge, redacted env values |
| `hlao reload` | Apply config without losing sessions | Restart required | Atomic re-read; new spawns only |
| `hlao restart` | Upgrade/clean restart | `down` + next command | Explicit command with loss warning |
| `doctor --no-start` | Diagnose without a daemon | Always autostarts | Opt-in `--start` |
| `doctor --probe` | Verify adapter handshake/auth | Command presence only | Spawn/initialize/close, opt-in |
| Adapter versions | Diagnose drift | Command path only | Show package versions/protocol |
| Project policy/timeouts | Per-repo gating | Only `backends` accepted | Extend project schema deliberately |
| Per-backend defaults | A backend may imply cwd/mode/policy | All per spawn | Manifest defaults with CLI override |
| Env interpolation | Portable configs | Literal strings only | `${VAR}` and `~` expansion with explicit rules |
| Default backend | Avoid repeating backend name | Required every spawn | `defaultBackend` in user config |
| Config schema | Editor validation/autocomplete | None | Ship JSON Schema and reference it |
| Shell completion | Normal CLI expectation | None | bash/zsh/fish/PowerShell |
| Command aliases | Muscle memory | None | `ls`, `rm`, `ps`, `tail` |
| Autostart control | Scripts may want failure | Autostart always (except `down`) | `--no-start` global |
| Version mismatch warning | Upgraded CLI + old supervisor | Doctor only | Warn on every command |
| Live log rotation | Long-running supervisor | Rotates only at startup | Rotate by size while running |
| Doctor writability checks | Home/log/socket permissions | Not checked | Check and report |
| macOS CI | README claims macOS support | Ubuntu + Windows only | Add a macOS job |
| Worktree example | Parallel coding workers need isolation | None | Document `--cwd` + worktree recipe |
| Notification hooks | Long jobs need alerts | None | Document a `wait`-based example; optional `--exec` |
| Fan-out/fan-in example | Parallel workers are a core shape | Four assemblies, no fan-out | Add `examples/acceptance/fanout.mjs` |
| Update check | Know when the CLI is stale | None | Compare packaged version; optional self-update |

### Agent ergonomics and integration

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| `hlao` on PATH inside a session | README says “run hlao from PATH” | Only `HLAO_CLI` is injected | Inject a shim dir/wrapper or assert the CLI is global in doctor |
| `HLAO_NAME` / name in whoami | Agent self-identity | Not injected | Add |
| Parent channel | `PRODUCT.md` says ask the parent | Forbidden | P0-3 |
| Sender identity | Know who asked | Missing | P0-11 |
| MCP server configuration | Session-scoped tools are common | Adapters use their own config; ACP `mcpServers` not exposed | `spawn --mcp FILE`/config, adapter-dependent |
| Schema introspection | Agents building commands | Contracts only | `hlao schema --json` |
| MCP wrapper | Tool-native agent integration | Deliberately absent | Optional wrapper, never the only surface |

---

## P2 — Polish and rough edges

These are individually small but collectively make the tool feel younger than it is. Each was observed or is directly visible in the rendering code.

### Parsing and command strictness

1. **Extra positionals are silently ignored** for `read`, `wait`, `cancel`, `close`, `permit`, `agents`, `doctor`, `whoami`, and `down`. `hlao wait <id> extra` waits only on `<id>` and exits 0. This is a trap for anyone expecting multi-ID wait, and it hides typos. Reject unexpected positionals; `mode` already does.
2. **An option missing its value swallows the next flag.** `hlao list --home --json` creates a directory literally named `--json`, starts a supervisor for it, and prints human output — no error. Reject values that start with `-` for string/duration/number options (or at least for `--home`/`--cwd`), and make `--home` echo the resolved path.
3. **`hlao help <unknown>` prints full help and exits 0.** It should error with the unknown topic.
4. **`--json` is ignored by `help` and `version`.** `hlao version --json` prints text; `hlao help spawn --json` prints text. If `--json` is global, these should either honor it or explicitly reject it.
5. **`--json` detection is `argv.includes("--json")`,** so a message containing the literal `--json` after `--` can force JSON error rendering. Edge case, but easy to fix by using the parsed flag.
6. **No case-insensitive enum handling.** `--permission ASK`, `--until IDLE` fail; acceptable, but a hint listing valid lowercase values would help.
7. **`send` lacks `--prompt` and `--prompt-file`,** while `spawn` has both. `send --stdin < file` works, but the asymmetry is unexplained.
8. **`--timeout` without `--wait` silently does nothing** on `spawn`/`send`; warn.
9. **`--since` without `--until change` silently does nothing** on `wait`; warn.
10. **No `--` documentation** in `help`, although the parser supports it. Add a line: “use `--` before a message that begins with `-`.”

### Human rendering

11. **`agents` left-truncates command paths into nonsense.** On Windows the output shows `…O\node_modules\@agentclientprotocol\codex-acp\dist\index.js` — a cut in the middle of a directory name. Use middle ellipsis, show the basename, or wrap.
12. **`spawn` output omits the `--name` label.** Users who named the session still see only the random ID.
13. **`spawn` output omits the permission policy.** With the default `allow`, every tool request is auto-approved; the command should say so, at least when the active policy is `allow` or `deny`.
14. **First-turn text runs messages together.** `spawn --wait`/`send --wait` concatenate all `agent.message` chunks regardless of `messageId`. The scripted slow agent renders `working…stopped: end_turn` on one line. `read` separates messages; the wait result should too (insert a newline when `messageId` changes, or render the turn’s events).
15. **Permission details are printed twice in `read`:** once as current state in the header, once as the `permission.requested` event. Keep one, or label the header “current pending permission.”
16. **Failed/closed session headers show a stale PID and no exit detail.** `read ss164y` displays `pid 38928` and “session failed: ACP connection closed”; `SessionView.exit.code = 3` is only in JSON. Show `exit 3 (signal)` and `endedAt`.
17. **`usage` hides cost.** The event data includes `cost`; the human line shows only `used/size tokens`. Show cost when non-null.
18. **`plan` prints at most 10 entries with no “and N more” marker.** Add a truncation line.
19. **`read` with a tail page and earlier events prints no hint.** See P0-5; also show `earliestRetainedSeq` in the header when it is greater than `events[0].seq`.
20. **`read` on a page with no events just says “no events.”** Say “no events after #N (last seq M)” so a cursor past the end is distinguishable from an empty log.
21. **The `--raw` name is overloaded.** Human `--raw` reveals stderr/commands; JSON `--raw` adds ACP payloads; tool payloads are shown in neither human nor (by contract) plain JSON. Split into `--raw` (ACP envelopes) and `--verbose` (human detail).
22. **No timestamps anywhere in human output** — the single most important polish item for long jobs.
23. **No pager/wrapping.** A large read page or long tool title floods the terminal.
24. **Agent-supplied text, names, tool titles, and cwd are printed without ANSI sanitization.** An untrusted or compromised agent can emit terminal control sequences. Strip ESC sequences from human output (or offer `--preserve-ansi`).
25. **No `--no-color` flag.** `NO_COLOR` works; an explicit flag is expected.
26. **`list` does not mark the caller’s own session** in a scoped view.
27. **`list` sorts by `createdAt`, oldest first.** A dashboard usually wants most-recent activity first; add `--sort activity` and consider it the default for human output.

### Error messages and diagnostics

28. **`mode <id> bad` renders permission-style options with `?`:** `options: Manual (?), Auto (?), Bypass (?)`. The generic options renderer assumes `optionId`/`kind`; modes have `id`/`name`. Show `default`, `auto`, `bypassPermissions`.
29. **A crashed spawn says “ACP connection closed”** without the exit code that `SessionView.exit` holds. Include it and the last stderr line.
30. **`not_found` does not suggest `hlao list`.** Add a hint, especially now that names are not resolvable.
31. **`doctor` says “home … (will be created)” and then creates it** in the same run. Report `created`/`ok` truthfully, or don’t create it.
32. **`doctor` does not print the log path when healthy.** Always print it, or add `status`.
33. **`agents` human output omits `envKeys`** even though `AgentView` has them; users cannot see which environment variables are configured. Show keys (never values) or add `--show-env`.
34. **`agents` human output lacks config file paths.** “user”/“project” is not enough when debugging which file won.
35. **`down` prints only a count.** For a destructive command, print the affected sessions (id/name/status) or support `--dry-run`/`--yes`. The same applies to `close --tree`, which prints only “closed N sessions.”
36. **`whoami` reports env values without validating the session.** A stale `HLAO_SESSION_ID` prints a session identity; `list` then silently returns an empty scope. See P0 below.
37. **No troubleshooting section in README.** Given the autostart/config/log quirks, a “when things go wrong” section is overdue.

### Parser edge cases and docs

38. **`--home` before the command rejects a flag-like value; after the command it accepts it.** Make the behavior consistent.
39. **`contracts/session.md` numbers two invariants as “6.”** Docs nit.
40. **README’s command table omits `help` and `version`.**
41. **README says “Global flags … may appear before or after the command,”** but `--json` has no effect on `help`/`version`, and `-h` before a command prints the full help rather than the command’s help. Qualify the claim.
42. **README says “Evictions are reported … never silent.”** False for tail reads (P0-5).
43. **README says `doctor` checks “backend readiness.”** It checks command resolution only (P0-8).
44. **README says “An operator shell … sees everything.”** A stale `HLAO_SESSION_ID` sees nothing and exits 0; the distinction matters.
45. **README says an agent has “the same CLI and a scoped view,”** but the agent must repeat `$HLAO_SESSION_ID` everywhere and cannot contact its parent.
46. **`docs/context.md` records Codex `403 GROUP_NOT_ALLOWED` while `doctor` would call the same backend “ready.”** Align the wording.
47. **CI does not test macOS** even though the README claims macOS support.
48. **The supervisor log rotates only at startup.** A supervisor left running for weeks can grow the log without bound; rotate by size during writes (with a size check that is cheap) or expose a log command that manages it.
49. **No version-mismatch warning on normal commands.** After upgrading the CLI, an old supervisor keeps running; only `doctor` mentions the version difference. Print a one-line stderr warning and suggest `hlao restart`.
50. **Package metadata lacks `repository`, `homepage`, and `bugs`.** Minor distribution polish.
51. **Spawn parameters are not fully recorded.** `session.created` includes backend, cwd, parent, root, depth, and policy, but omits the `name`, the requested mode, and the env keys. (Never log env values.) A user asking “what was this session started with?” cannot answer from the retained event log alone.
52. **`HLAO_DEBUG=1` is the only supervisor debug switch and is undocumented.** There is no `--verbose`/log-level control for supervisor diagnostics, and the log path is not printed on success.
53. **A queued message cancelled before it starts returns exit 0.** `send --wait` reports `stopReason: "cancelled"` with `completed: true` and no distinct exit code; a script may treat it as success. Consider a distinct code or a machine-readable `outcome`.
54. **`list --cwd` is exact-match only.** There is no subtree/prefix filter, and on Windows path comparison is not case-insensitive. Users organizing workers under a repo root will expect `--cwd` to include subdirectories or an explicit `--cwd-prefix`.

---

## Contradictions between docs and behavior

These deserve explicit resolution, because the docs are one of the project’s strengths and should stay trustworthy.

| Doc claim | Actual behavior | Recommendation |
|---|---|---|
| `PRODUCT.md`: a bounded-ignorance participant can “ask the parent.” | A child cannot `send`, `read`, or `wait` on its parent; all are `forbidden`. | Add a parent-send channel (P0-3) or amend the claim. |
| README: “Evictions are reported with `truncated`, never silent.” | Tail reads set `truncated: false` and print no warning. | Fix the tail path and the README (P0-5). |
| README: `doctor` checks “backend readiness.” | Readiness means the adapter entry resolves; no handshake or auth check. | Add `--probe` and call the current check “adapter present” (P0-8). |
| CLI contract: “Original ACP payloads are returned only with `--json --raw`.” | `rawInput`, `rawOutput`, and `content` are returned without `--raw`. | Strip unless raw, or document the exception (P0-9). |
| README: “Global flags … may appear before or after the command.” | `--json` is ignored by `help`/`version`; `-h` before a command means full help. | Qualify the claim or make the behavior uniform. |
| README: “An operator shell … sees everything.” | A stale `HLAO_SESSION_ID` yields an empty scope and exit 0. | Validate identity; error or warn (P0-2/identity). |
| README: “The agent has the same CLI and a scoped view.” | No self-default and no parent channel; the agent is a second-class caller. | P0-2 and P0-3. |
| `docs/context.md`: Codex returns `403`. | `doctor`/`agents` show it as ready. | Distinguish “installed” from “authenticated/working.” |
| `contracts/session.md`: two invariants numbered 6. | Docs nit. | Renumber. |
| README command table. | Omits `help` and `version`. | Add them. |

---

## Suggested sequence

### Phase 0 — One or two days, almost entirely CLI-only

Highest value per line of code:

1. Default the session ID to `HLAO_SESSION_ID` in session-targeting commands.
2. Fix tail-read eviction reporting and add the older-history hint.
3. Make `wait` return nonzero when the awaited condition was not met and the session died.
4. Add `read --follow` and `list --watch` as CLI-side loops; add a stderr heartbeat to long waits.
5. Make `spawn --wait` print the handle before waiting (two-phase CLI assembly).
6. Add `hlao status` and `hlao logs`.
7. Make `doctor`/`agents` non-mutating by default; add `config show/path`.
8. Human read: timestamps, tool input/output behind `--verbose`, duplicate-permission cleanup, exit detail.
9. `list`: scope footer, policy/mode columns (or `--wide`), pending/turn age, tree view, basic filters, activity sort.
10. Parser strictness: reject extra positionals and flag-like values; fix `mode` option rendering; `help <unknown>` error.
11. `spawn` output: name, policy, no run-together agent text.
12. `agents` path rendering; permission dedupe; failed header exit detail.

### Phase 1 — Supervisor + protocol, still within the thesis

1. Name resolution and `rename`; include names in outputs.
2. `policy` command; thread caller identity into all mutating events; sender on prompts.
3. Queue contents/drop and `cancel --keep-queue` (product sign-off).
4. Config reload; `agents` reads disk; doctor compares loaded vs disk.
5. Model/config options (`--model`, `hlao option`), with fake-agent tests.
6. `--parent` on spawn; multi-ID `wait --any/--all`.
7. Bulk/idle close; `close --dry-run`.
8. Doctor `--probe`; adapter versions/protocol; version-mismatch warning.
9. Fan-out and notification examples; `read --since 0` export documented.

### Phase 2 — Product decisions

1. Child → parent channel (or a doc amendment).
2. `hlao resume` with ACP `session/load`/`resume`; warm-host only.
3. Turn timeout/watchdog as a documented assembly (or a one-shot `--turn-timeout` if the product accepts the authority).
4. Notification hooks/webhooks as examples, not core.
5. Optional MCP wrapper; never the only surface.

### Explicit non-goals (do not “fix” these)

- No scheduler, cron, DAG, workflow engine, kanban, task store, or workflow graph.
- No global session registry or cold-host lineage reconstruction.
- No durable event store as the authority; an export is a file, not a store.
- No provider subagent surfacing, client `fs`/`terminal` capabilities, or hidden tool surface.
- No HTTP API, multi-user server, or remote supervisor; the local per-user supervisor is the boundary.
- No PTY fallback or interactive attach in 0.1; ACP is the only transport.
- No auto-recurring timers in the supervisor. A CLI-side follow/watch loop is fine because the caller owns it.
- No replacement of `wait`'s one-shot semantics.

---

## Tests to add alongside the fixes

The current 62 tests are green and cover the core. The gaps that let the issues above ship:

1. Tail read after eviction: `truncated`/`earliestRetainedSeq` and human hint.
2. `wait --until idle|permission|change` on a failed session: exit code and `satisfied`.
3. Name resolution: unique, ambiguous, scoped-out, and rename.
4. Default-self commands inside a simulated session environment.
5. Child → parent send semantics (whatever is decided), including forbidden read/wait.
6. Config reload: add a backend, new spawn sees it, live session unaffected.
7. `agents`/`doctor` do not autostart when asked not to.
8. Actor attribution: parent permits child; child sends to parent; event shows the right ID.
9. Queue contents/sender; keep-queue cancel.
10. Human rendering snapshots: timestamps, tool payloads under verbose, scope footer, exit detail, deduped permission.
11. Parser: extra positionals rejected; `--home --json` rejected; `--` preserves a dash-leading message.
12. Model/config options with a fake agent that advertises them.
13. `read --follow` stop conditions: terminal state, timeout, Ctrl-C (child process signal), and no duplicate events.
14. `spawn --wait` prints the handle before the turn completes.
15. macOS CI job, or remove the macOS support claim.

---

## Evidence appendix

Environment: Windows 11, Node 26.8.1, HLAO 0.1.0, isolated homes, `tests/fixtures/fake-acp-agent.ts` as the `fake` backend. `npm test` was run: 62 tests, 62 pass.

**Name not a handle**

```console
$ hlao list
ID      NAME          BACKEND  STATUS  TURN  QUEUED  AGE  CWD
ss164y  crasher       fake     failed  1     —       now  D:\Fizz\Dev\HLAO

$ hlao wait crasher --until exit
hlao: no session matching "crasher"
# exit 1
```

**Dead session is a successful idle/permission wait**

```console
$ hlao wait ss164y --until idle --timeout 1s
ss164y is failed (waited 0ms)
# exit 0
$ hlao wait ss164y --until permission --timeout 1s
ss164y is failed (waited 0ms)
# exit 0
```

**Child cannot contact parent**

```console
$ HLAO_SESSION_ID=<child> hlao send <parent> "hello parent"
hlao: session <parent> is outside the caller's scope
# exit 1
```

**Stale identity silently empties the scope**

```console
$ HLAO_SESSION_ID=zzzzzz hlao whoami
session zzzzzz · parent — · root —
# exit 0
$ HLAO_SESSION_ID=zzzzzz hlao list
no sessions in your scope
# exit 0
$ HLAO_SESSION_ID=zzzzzz hlao spawn fake x
hlao: caller session zzzzzz is not live; cannot derive a parent
# exit 1
```

**Silent eviction on tail read**

```console
# config: { "maxEventsPerSession": 3 }
$ hlao read <id>
#8  tool › Read the prompt → completed
#9  usage › 42/200000 tokens
#10 — turn 1 ended: end_turn —

$ hlao read <id> --json
{ "first": 8, "last": 10, "earliestRetainedSeq": 8,
  "truncated": false, "hasMore": false }

$ hlao read <id> --since 0
... 
earlier events were evicted; retained history starts at #8
```

**Stale config after edit**

```console
$ hlao agents
claude  builtin  yes ...
codex   builtin  yes ...
$ # add backend "later" to <HLAO_HOME>/config.json
$ hlao agents
claude  builtin  yes ...
codex   builtin  yes ...
# "later" absent
$ hlao doctor
✓ config: ...\config.json
✓ backends: 2/2 ready (claude, codex)
```

**`spawn --wait` hides the handle until turn end; messages run together**

```console
$ time hlao spawn fake "slow spawn" --env FAKE_MODE=slow --env FAKE_DELAY_MS=3000 --wait
spawned 6qhy86 (fake) in D:\Fizz\Dev\HLAO
working…stopped: end_turn
— turn 1 ended: end_turn —
# elapsed ~3.2s; no output before the turn ended
```

**Human read omits timestamps and tool I/O**

```console
$ hlao read 38g8rj
#5  thinking › considering the prompt
#6  tool › Read the prompt [read]
#7  agent › echo: hello world
#8  tool › Read the prompt → completed
#9  usage › 42/200000 tokens
#10 — turn 1 ended: end_turn —
```

`read --raw` prints the same tool lines; `--json` contains `rawInput`/`rawOutput` fields in `tool.call`/`tool.update` even without `--raw`.

**Permission block duplicated in read**

```console
$ hlao read vysgeg
permission needed › Run the build
  allow_once   Allow once (allow)
  allow_always Always (allow-always)
  reject_once  Reject (reject)
  allow: hlao permit vysgeg --allow
...
#6  permission needed › Run the build
  allow_once   Allow once (allow)
  ...
```

**Mode error renders `?`**

```console
$ hlao mode vysgeg nope
hlao: mode "nope" is not available
  options: Manual (?), Auto (?), Bypass (?)
# exit 1
```

**Extra positional silently ignored**

```console
$ hlao wait <id> extra --timeout 100ms
<id> is idle (waited 0ms)
# exit 0
```

**Missing option value swallows the next flag**

```console
$ hlao list --home --json
no sessions — hlao spawn <backend> "message"
# exit 0; a directory named "--json" was created and a supervisor started for it
```

**Project config rejects policy**

```console
$ hlao agents --cwd <project-with-permissionPolicy>
hlao: project config has unknown field "permissionPolicy"
# exit 1
```

**No live policy command**

```console
$ hlao permit vysgeg --allow --always
hlao: session vysgeg has no pending permission
# exit 1
```

**`agents` path truncation**

```console
codex  builtin  yes  …O\node_modules\@agentclientprotocol\codex-acp\dist\index.js  ...
```

**Scope is invisible in human `list`**

```console
$ HLAO_SESSION_ID=<parent> hlao list
ID      NAME        BACKEND  STATUS  TURN  QUEUED  AGE  CWD
a58m9e  parent-job  fake     idle    1     —       now  ...
7ewy1s  child-job   fake     idle    1     —       now  ...

$ hlao list
# five rows, identical header/format; no "scope: session" indicator
```

**Failed header has no exit code**

```console
$ hlao read ss164y
ss164y  crasher  fake  failed
cwd D:\Fizz\Dev\HLAO · turn 1 · seq 5 · mode default · policy allow · root · pid 38928
...
#5  session failed: ACP connection closed
# JSON session.exit = { code: 3, signal: null }
```

**Queue event has no text or sender**

```json
{"position":2,"textLength":14}
```

**Test-suite note:** the unit test named “eviction is reported, never silent” calls `read({ since: 0, ... })`; it does not exercise the tail path. Likewise, “raw payloads are stripped unless requested” checks only the `raw` key, not `rawInput`/`rawOutput`/`content`. Both gaps correspond to issues above.

---

## Closing assessment

HLAO’s design bet is sound, and the implementation has the rare quality of being smaller than its documentation. The problem is that the documentation describes a surface a person can drive, while the CLI still assumes the user is a script that already knows the random ID, has a shell loop for monitoring, and never needs to change configuration.

The next release should not add orchestration concepts. It should make the existing ones **addressable** (names/self), **truthful** (eviction and wait semantics), **observable** (follow, timestamps, tool I/O, status, logs), and **operable** (config reload, policy control, cleanup). Those are all affordances around the same five primitives; none of them requires a scheduler, a store, or a registry.

If only three things can ship: **name/self addressing**, **non-silent eviction plus a truthful `wait` exit code**, and **`read --follow` with `status`/`logs`**. Those three change HLAO from “a correct substrate” to “a tool I would actually reach for.”
