# HLAO — New feature and usage findings (0.10 review)

**Reviewed:** 2026-10-20, branch `milestone/0.9-maintenance`, Node 26.8.1, Windows 11.
**Artifact under test:** the built CLI and supervisor (`hlao version` reports **0.5.0**; that mismatch is itself R-28).
**Scope:** product features, operator/agent usage, output truthfulness, and polish. Implementation style is
not the subject except where it produces a user-visible lie.
**Method:** read `README.md`, `contracts/`, `docs/`, the ADRs, the skill, and the relevant source; then drove
the real CLI against a real supervisor in isolated `HLAO_HOME`s, using the bundled scripted ACP agent plus a
custom ACP agent that emits plan, compaction, subagent, notice, command, user-message, and inter-session
message updates. Cold start, malformed config, project config, queues, permissions, adapter crashes,
retention, export, and JSON/human parity were exercised.

This document is **additive** to `FEATURE-REVIEW.md`. Nothing already in that ledger is repeated. Where a
finding is adjacent to an existing entry, the delta is stated. The old ledger remains the source of truth for
P0-14 (resume), N-08 (advisory control), N-10 (permission rules), N-11 (resource bounds/budget), the
addressing/organization table (`@last`, tags, broadcast), the operations table (`init`, restart, completion,
default backend, config schema, etc.), and every P2 item still listed there.

---

## Executive summary

The primitive surface is coherent, the supervisor is unusually well-instrumented, and the CLI's error and
help text is better than most tools at this stage. The problems are concentrated in three places:

1. **The human transcript is not a truthful record of a multi-agent session.** `read` labels every prompt
   `you`, even when another session sent it; hides who closed/cancelled/renamed; and collapses queued and
   discarded messages to a position or a reason. The JSON has the facts; the operator's primary view does
   not.
2. **Provider-native state is advertised wrongly and projected lossily.** HLAO does not advertise ACP
   `compaction`, `notices`, or experimental `plan` capabilities, so a compliant adapter is told not to send
   the very signals an operator needs on a long job. When those updates do arrive, compaction and subagent
   events are stored as empty shells and render as the bare word `compaction`/`subagent`; ACP inter-session
   messages become `raw`; `user_message_chunk` is rendered as nothing at all. Plan deltas and provider
   session titles never reach `get`/`list`.
3. **Fleet-level observation and bulk operations are missing.** `list --watch` shows state, not events;
   there is no cross-session event tail or merged timeline; export is one session at a time even though
   `down` discards them all; and time-range/regex search does not exist. For a tool whose thesis is seeing
   the situation, these are central affordances, not conveniences.

The highest-value fixes are not new primitives. They are truthfulness repairs (R-01 to R-06, R-31), the
crash/loss signal (R-07), agent-birth guidance repairs (R-08, R-09), and projections of state the wire
already carries (R-10 to R-13).

### Top findings, ranked

| Rank | ID | Finding | Severity |
|---|---|---|---|
| 1 | R-01 | Human `read` misattributes every prompt as `you`; actor fields are hidden on several mutating events | P1 |
| 2 | R-03 | Human `wait --until settled` exits 3 on a terminal session while JSON and the docs say 0 | P1 |
| 3 | R-31 | `wait --until idle` returns success for a permission-parked session, contradicting the documented idle meaning | P1 |
| 4 | R-07 | A supervisor crash silently loses the table; the next command starts fresh and says "no sessions" | P1 |
| 5 | R-08 | The skill/README worker loop tells an agent to `send --self --wait`, which deadlocks against its own turn; self-permit is also impossible while parked | P1 |
| 6 | R-10 | Context compaction is invisible by construction: capability not advertised, event projected empty, no view field | P1 |
| 7 | R-06 | A malformed user config silently autostarts a degraded supervisor; `list` exits 0 and reports an empty instance | P1 |
| 8 | R-05 | `list --cwd` with no match reports false instance totals (`0 live · 0 retained`) | P1 |
| 9 | R-04 | `get` human output is one header line, while its help promises queue, settlement, options, usage, pending, lineage | P1 |
| 10 | R-12 | ACP inter-session messages become `raw`; `user_message_chunk` is invisible in human output | P1 |
| 11 | R-02 | Queue/discard events lose message id, sender, and preview in human output; after cancel the content is only in JSON | P1 |

---

## What is working (and should not be disturbed)

These are worth stating because the report is otherwise critical.

- **Help and error quality.** Invalid mode/option values list the available choices; unknown event types list
  the taxonomy; missing backends list alternatives; spawn failures include adapter stderr and a recovery
  hint. This is materially better than typical early CLIs.
- **Idempotent delivery.** `spawn`/`send --idempotency-key` behave correctly and report duplicates clearly in
  both human and JSON output (`already sent msg-…`, `duplicate spawn, reusing …`).
- **Permission presentation.** `wait --until permission` prints the tool, every option with its id, and the
  exact `permit` commands; `permit` accepts the option id; `mode` and `option` validation list alternatives.
- **Bounded, honest event history.** Cursors, `hasMore`, `nextBefore`, `earliestRetainedSeq`, `truncated`,
  and eviction reporting are consistent. `export` pages the full retained history and reports what was lost.
- **Terminal safety.** Adapter-derived text is sanitized; CSI and OSC sequences are stripped, control and
  bidi characters are removed, and table widths account for CJK/emoji.
- **Lifecycle hygiene.** Graceful close, process-group termination on POSIX, Windows tree kill, stale-lock
  verification, atomic lock writes, queue discard on failure, and `down --dry-run` are all present.
- **Config validation.** Unknown keys are rejected and errors name the file. Backend env values are redacted
  in `config show`; the token and Unix socket are mode `0600`; adapter startup errors surface stderr.
- **Lineage.** `spawn --parent`, `list --tree`, `list --mine`, and header `parent`/`root` fields are coherent,
  and spawning under a failed parent is correctly rejected.

---

## A. Truthfulness of the human view

### R-01. Human `read` labels every prompt `you`, regardless of sender — P1

**Type:** bug / attribution.
**Evidence.** With session `nx6jss` as caller, sending to `nhy472` produced JSON:

```json
{"type":"prompt.sent","data":{"text":"from sibling session","from":"nx6jss"}}
```

Human `read nhy472` printed:

```text
#19   15:53:48 you › from sibling session
```

The renderer hardcodes `you` (`src/cli/render.ts:337`). It never reads `data.from`. The same selective
silence affects other actor-bearing events:

| Event | JSON field | Human output |
|---|---|---|
| `prompt.sent` | `from` | always `you` |
| `prompt.queued` / `prompt.discarded` | `from`, `by` | omitted |
| `session.closed` | `by` | `session closed` |
| `cancel.requested` | `by` | `cancel requested` |
| `session.renamed` | `by` | `session renamed · …` |
| `session.created` | `createdBy` | omitted |
| `permission.resolved`, `policy.changed` | `by` | correctly shown in parentheses |

**Why it matters.** Universal addressing means any session can message or stop any other. The operator's
primary transcript currently reads as if the operator did all of it. Debugging delegation, interference, or
a surprising close becomes guesswork unless the operator switches to JSON and reconstructs the event log.

**Fix shape.** Render `from`/`by` consistently: `agent:nx6jss › …`, `operator › …`, or
`from nx6jss › …`; add `by` to closed/cancel/rename/created. Add human/JSON parity tests for actor fields.
Also surface `createdBy` in `list --wide` and the `get`/`read` header (see R-13/R-04).

**Effort:** S.

---

### R-02. Queue and discard events lose message identity and content — P1

**Type:** truthfulness / information loss.
**Evidence.** `read --json` shows full metadata:

```json
{"type":"prompt.queued","data":{"messageId":"msg-r9sy4rt6","position":2,
 "textPreview":"second prompt","textLength":13,"from":"operator"}}
{"type":"prompt.discarded","data":{"messageId":"msg-r9sy4rt6","text":"second prompt",
 "from":"operator","by":"operator","reason":"cancel"}}
```

Human `read` prints only:

```text
#6  15:48:13 queued message (position 2)
#8  15:48:20 discarded a queued message (cancel)
```

After `cancel`, the queue is gone, so the human transcript is the only record — and it no longer says what
was discarded or who sent it. `queue` shows ids/previews while queued, but not after discard.

**Why it matters.** “Cancel” is destructive by default (it discards the backlog). Losing the content at the
same moment is the worst possible time to lose it. The event data is already there; only the renderer drops
it.

**Fix shape.** Render `msg-… · from … · preview` for queued and `msg-… · from … · preview (reason)` for
discarded, with the same bounded preview used by `queue`. Carry message ids into `prompt.sent` human output
too (R-26).

**Effort:** S.

---

### R-03. `wait --until settled` returns the wrong human exit code — P1

**Type:** bug / exit-code truthfulness.
**Evidence.** On a failed (terminal) session:

```console
$ hlao wait crash1 --until settled
crash1 (jmp5v4) ended before reaching "settled" (waited 0ms): failed · exit 4
$ echo $?
3
```

```console
$ hlao wait crash1 --until settled --json
{ "satisfied": true, "reason": "exit", ... }
$ echo $?
0
```

`README.md:95` says “for `settled`, termination is a valid completion”; `contracts/cli.md:155` says the same.
The supervisor and JSON agree. `renderSingleWait` returns 3 for any `reason === "exit"` unless
`--until exit` (`src/cli/commands/wait.ts:274-288`), discarding the already-computed `code`. The multi-target
human path returns the computed code, so single and multi also disagree.

**Why it matters.** Scripts use human mode too, and the documented semantics are exactly what orchestration
loops rely on. This is the kind of inconsistency that makes a caller add a JSON call and a fallback parser.

**Fix shape.** Let `renderSingleWait` receive/return the computed code, or special-case `until === "settled"`
as satisfied. Add tests for human and JSON exit codes on closed and failed sessions, single and multi.

**Effort:** S.

---

### R-31. `wait --until idle` reports success for a permission-parked session — P1

**Type:** bug / condition semantics.
**Evidence.** On a session parked at a permission request:

```console
$ hlao wait perm2 --until idle --timeout 2s
perm2 (69fqw0) needs permission (waited 0ms)
permission needed › Run the build
  allow_once   Allow once (allow)
  …
$ echo $?
0
```

`get perm2` reports `waiting_permission`, `settled: false`, and `turnStartedAt` set. `help wait` defines
`idle` as “no active turn and no queued prompt” and then says the CLI uses the wire's completion condition,
with `settled` as the explicit form. The supervisor's `settled` intentionally treats a pending permission
as a completion (it is an actionable stop), but a parked request is still an active turn. The CLI only
downgrades `reason === "exit"` for the historical `idle` contract (`wait.ts:183-190`); permission therefore
counts as idle success. Both help sentences cannot be true for this state.

**Why it matters.** A monitoring loop that waits for `idle` to mean “the turn finished” will wake at the
permission gate and may proceed as if the work completed. The same loop using `wait --until permission`
would be explicit and correct. This is the same family as R-03: the human condition table and the exit code
disagree with the documented meaning.

**Fix shape.** Decide and document the contract. If `idle` must mean “no active turn and no queue”, the
client must keep waiting through a permission stop (a `settled` wake is not enough); that likely needs a
wire condition or a small client loop over `change` + status. If `idle` is intentionally an alias for
`settled`, say so in `help wait` and in the README, and keep `--until permission` as the explicit gate; then
rename the displayed condition or add `--until done` for “turn ended, not parked”. Whichever is chosen,
make human and JSON agree and add a test for a parked session. (R-03 is the terminal-session half of the
same mapping.)

**Effort:** S for docs, M if a precise idle condition is added.

---

### R-04. `get` human output does not deliver what its help promises — P1

**Type:** truthfulness / missing projection.
**Evidence.** `help get`:

> Print one session's orchestration state without reading events: status, turn, queue, settlement, policy,
> modes, config options, usage, pending permission, and lineage.

Actual `get` human output is one header line:

```text
q0dgt4  echo1  fake  closed
cwd … · turn 1 · seq 11 · mode default · policy allow · root · ended 3s ago · exit 0
```

`src/cli/commands/get.ts:21-26` returns `renderSessionHeader` and nothing else. The JSON result does contain
the promised fields. There is no way to see one session's queue, settlement, usage, config options, or pending
permission without `read`, `list --wide`, and `option` separately.

**Why it matters.** `get` is the natural “inspect this session” command. Today it is effectively a JSON-only
command whose human mode duplicates the `read` header.

**Fix shape.** Render a compact multi-line state block in human mode: status/turn/queued/settled, policy/mode,
model and other config options, usage/cost, pending permission, createdBy/parent/root/depth, exit. Keep the
one-line header for `read`, and offer `get --brief` if the block feels heavy. Add a test that every field
named in `help get` appears in human output or is explicitly marked JSON-only.

**Effort:** S.

---

### R-05. `list --cwd` with no match lies about the instance totals — P1

**Type:** bug / false empty state.
**Evidence.** With ten sessions in the instance:

```console
$ hlao list --cwd C:/definitely/not/a/session/cwd
no sessions — hlao spawn <backend> "message"
instance · 0 live · 0 retained
```

```console
$ hlao list --cwd C:/definitely/not/a/session/cwd --json
{"sessions":[],"counts":{"live":0,"retained":0,"total":0}}
```

Other filters behave correctly:

```console
$ hlao list --name zzz-nomatch
no sessions match the filters
instance · 4 live · 1 retained · showing 0
```

The difference is that `--cwd` is sent to the supervisor (`src/cli/commands/list.ts:99-104`) and scoped before
counts, while the other filters are client-side over the full table. `list` help does not document `--cwd` at
all (it documents only `--cwd-prefix`); the top-level help and README do.

**Why it matters.** An empty result from a filter must not look like an empty instance. This is precisely the
moment an operator fears sessions were lost.

**Fix shape.** Filter `--cwd` client-side, or have the supervisor return instance counts separately from
filtered counts and label the empty state “no sessions match the filters”. Document `--cwd` in `help list`
and state whether it is exact-match or prefix.

**Effort:** S.

---

### R-06. A malformed user config silently autostarts a degraded supervisor — P1

**Type:** truthfulness / fail-open startup.
**Evidence.** With a truncated `config.json`:

```console
$ hlao list
no sessions — hlao spawn <backend> "message"
instance · 0 live · 0 retained
$ echo $?
0
```

`status` then reports a running supervisor with the config error appended, still exit 0:

```text
running · pid 35676 · supervisor 0.5.0 · up 5s · 0 live sessions
protocol v2.3 · 16 capabilities · \\.\pipe\hlao-…
config error: …config.json: cannot parse … Expected property name or '}' …
```

`doctor` and `config validate` do exit 1, and `spawn` fails with `config_invalid`, but the first command a
user runs often autostarts the supervisor. The supervisor log records the error and then “listening”.

**Why it matters.** The user sees an empty instance, not “your config is broken”. The empty table plus exit 0
reads as “nothing here” rather than “I could not load your instance”. This is broader than ledger P2-0.5-18,
which is limited to `status --start` exiting 0.

**Fix shape.** Refuse to autostart on an invalid config (exit 1 with the parse error), or start in an explicit
degraded mode that prints a warning to stderr on every command and makes `list`/`status` report the degraded
state prominently. Do not exit 0 silently.

**Effort:** S.

---

### R-07. A supervisor crash loses the table with no signal — P1

**Type:** truthfulness / lifecycle. **Delta vs P0-14:** P0-14 asks for resume and says “at minimum, the loss is
signalled”; this finding is the signal and cleanup half, not a resume design.

**Evidence.** With a live table, force-killing the supervisor and running `list`:

```console
$ hlao list
no sessions — hlao spawn <backend> "message"
instance · 0 live · 0 retained
$ echo $?
0
```

`status` shows a new pid and `up 337ms`; the log contains the old “listening” line and the new one, with no
crash, stale-lock, or lost-session line. The old `supervisor.json` was simply replaced. Adapters in this test
exited when their stdin pipe died; the README correctly warns that Windows adapters can orphan, but nothing
detects or reports either outcome.

**Why it matters.** A long job can disappear and the next command looks successful. The operator has no
prompt to run `doctor`, inspect `logs`, or clean up orphan adapters. This is the same class of failure the
product exists to make visible.

**Fix shape.** On acquiring a lock whose prior `state` was `running`/`starting` and whose pid is dead, write
a `crash.recovered`/`stale_lock` notice with the old pid and start time; print a one-line warning on the
autostarting command. Add a `doctor` check for that marker and, if a process manifest is acceptable as
diagnostic (not orchestration) state, for live adapter pids. At minimum, `down --force`/`doctor` should
report stale adapter processes matching the home. Do not imply recovery; say the table and retained history
are lost.

**Effort:** S/M.

---

## B. Agent-at-birth guidance

The skill and README are part of the product surface: a spawned agent is the user who most needs the moves to
be correct. One problem here deadlocks an agent; the other corrupts the audit trail of the first prompt.

### R-08. The worker loop deadlocks on `send --self --wait`; self-permit is impossible — P1

**Type:** guidance/design bug. **Delta vs N-12:** N-12 shipped the skill; this is a correctness defect in the
worker loop it shipped, not a request for a new onboarding channel.
**Evidence.** `skills/hlao/SKILL.md` presents:

```bash
hlao send --self "Check the log again." --wait --timeout 20m
hlao read --since 42
hlao wait --until permission --timeout 10m
```

and `README.md:260-265` presents the same as “A typical worker loop”. A session is inside a turn when it runs
these commands. `send --self` queues behind that same active turn. Observed with a busy session:

```console
$ HLAO_SESSION_ID=s3dehx hlao send --self "check again" --wait --timeout 1s
self1 (s3dehx) busy — the message is still queued behind turn 1
next: hlao read s3dehx --since 7
exit=2
```

With a real agent, the next turn cannot start until the current turn ends, and the current turn cannot end
while the agent is blocked in `send --wait`: the `--timeout 20m` is a 20-minute self-deadlock, and `0` is
permanent. The same document also says a pending request should be answered with
`hlao permit <id> --allow`; a session parked on `session/request_permission` is waiting for the tool result
and cannot execute a new shell command to answer itself. The operator (or another session) must answer.

**Why it matters.** This is not an edge case; it is the first piece of agent guidance in the skill. An agent
that follows it burns its budget and reports a timeout, or worse, contends that the harness is stuck.

**Fix shape.** Rewrite the agent-facing loop to distinguish inside-turn from between-turn:
- Inside a turn, use `read`, `wait` on *other* sessions, and report blockers in the final message.
- A self-send is a *deferred next turn*: omit `--wait`, finish the current turn, and let the queued prompt run.
- A parked permission cannot be self-answered; the skill should say the operator/parent answers it, and the
  agent should leave a clear blocker in its output.
- Optionally guard `send --self --wait` when the caller is the target’s active turn and return a
  `bad_request` (“cannot wait for a self-message behind your own turn”) instead of timing out.
- Update README’s “worker loop” to match. Add an e2e test that a self-send with `--wait` while busy is either
  rejected or documented as deferred.

**Effort:** S for docs/guard; M if the supervisor should reject the pattern.

---

### R-09. The skill pointer glues onto the operator prompt and leaves no audit trail — P2

**Type:** prompt-integrity / auditability. **Delta vs N-12:** N-12 shipped the pointer and skill;
this is the delivery and audit trail of that shipped artifact.
**Evidence.** The first prompt is two ACP text blocks: the pointer (ending in `.`) and the user text, with no
separator (`src/session.ts:482-494`, `src/session/projection.ts:27-33`). An adapter that concatenates text
blocks, as the bundled fixture does, delivers:

```text
HLAO carries orchestration text, not file payloads; reference paths and use your own tools.hello world
```

`read` shows only `you › hello world`; `prompt.sent` JSON contains only `"text":"hello world"`. If the agent
does not echo its prompt, there is no record anywhere that the pointer was injected, which version it was,
or that the first line was concatenated. The pointer is also marked injected before `session/prompt` succeeds
(`#skillInjected = true` at `src/session.ts:483-488`), so a prompt request that errors without killing the
session will never resend it.

**Why it matters.** The first prompt is context the agent will act on. Gluing it changes the prompt; not
recording it makes the transcript an incomplete account of what the agent saw. The 0.8 decision explicitly
promised “the operator's prompt is never rewritten”, but delivery can effectively rewrite its first line.

**Fix shape.** End the pointer with `\n\n` (or send it as one text block with a blank-line separator) and add
a `prompt.injected` metadata field/event recording pointer version/path and block count. Mark injection
complete only after the prompt request returns. Consider a `--no-skill`-equivalent record so audits can tell
which sessions were pointed at which skill version.

**Effort:** S.

---

## C. Provider-native state

This is the largest feature-shaped gap. The wire carries ACP signals, but HLAO both fails to ask for the
interesting ones and then throws away their structure.

### R-10. Context compaction is invisible by construction — P1

**Type:** missing feature / bad capability advertisement. **Delta vs N-11:** N-11 is about resource bounds and
spend; this is the agent's own context state, which no existing ledger item tracks.
**Evidence.** HLAO's ACP `initialize` advertises only:

```ts
clientCapabilities: { session: { configOptions: { boolean: {} } } }
```

(`src/session.ts:1326-1332`). It does **not** advertise `session.compaction`, `session.notices`, or `plan`
(`subagents` is intentionally not advertised per the README; the other three are explained nowhere as
deliberate omissions). ACP says `compaction_summary_chunk` may only be sent when the client advertised
`ClientSessionCapabilities::compaction`; a compliant adapter therefore will not send compaction summaries at
all. When a custom agent sent valid `compaction_update`/`compaction_summary_chunk` anyway, HLAO stored:

```json
{"type":"compaction","data":{}}
```

and human `read` printed a bare `compaction` line for each. With `--json --raw` the private payload is
recoverable, but default JSON drops it (`stripPrivateData` removes `raw`). `SessionView` has no compaction
field, `get`/`list` show nothing, and there is no `wait --until compaction` or context-pressure warning. The
only context signal is the latest `usage` used/size snapshot.

**Why it matters.** Long-running jobs are exactly where an agent hits its context limit. Compaction is the
moment its memory changes; an operator who cannot see it cannot tell why a previously reliable agent started
forgetting the task. The product's own thesis is “see the situation”; this is the situation.

**Fix shape.** Advertise `session.compaction` (and `session.notices`) and project `compactionId`, status,
summary/error into first-class event data. Add `SessionView.compaction` (last status/id/tokens if available)
and a `context` summary; render `compaction › started/completed · summary`; add a context-pressure warning
(for example at 75/90% of `usage.size`) as an event/notice, not a timer. Add `wait --until compaction` only if
the event is reliable; otherwise document a caller loop over usage. Do not implement a scheduler.

**Effort:** M.

---

### R-11. Plan deltas and provider session titles never reach the session view — P1

**Type:** missing projection / human-output gap.
**Evidence.** A valid `plan_update` produced JSON with the whole new plan under `data.update.plan`, and human
`read` printed only:

```text
#7   15:55:58 plan.update
```

`plan_removed` is projected as `{removed:true}` and loses `planId`. The initial `plan` event is rendered well
(`plan › N entries`, first ten entries); only deltas are invisible. `session_info_update` is projected as
`session.info` and rendered as `session › Provider Session Title`, but the title is not stored in
`SessionView`; `get`/`list` cannot show it. HLAO also does not advertise the experimental `plan` capability,
so a compliant adapter may use only full `plan` replacements, never deltas.

**Why it matters.** The current plan is the closest thing to “what is the agent doing next?” and a title is the
cheapest way to distinguish ten sessions. Both are already on the wire and both are missing from the
state view. `get` — the command that should answer this — cannot.

**Fix shape.** Project the latest plan into `SessionView.plan` (entries plus updatedAt) and the latest title
into `SessionView.title`; render plan changes as diffs or a compact `plan › 2/5 done · current: …`; use the
provider title as a fallback label in `list` (operator name wins). Advertise `plan` if deltas are wanted, and
document that experimental updates are opt-in. Keep `plan_removed` carrying `planId`.

**Effort:** M.

---

### R-12. ACP inter-session messages and user-message chunks are dropped or hidden — P1

**Type:** forward-compatibility / missing projection.
**Evidence.** A valid `session_message` and `session_message_chunk` were projected as generic `raw` with
`data:{}` in default JSON; human `read` printed two bare `raw` lines. The ACP fields `messageId`,
`senderSessionId`, `recipientSessionId`, and `content` only survive under `--json --raw` (or `--raw` human,
which still just prints `raw`). Separately, `user_message_chunk` maps to `user.message` with text/messageId,
but the human renderer has a bare `break` for that case (`src/cli/render.ts:332`): filtering
`read --type user.message` prints a header and no events at all.

**Why it matters.** ACP's experimental `session_message` is a protocol-level version of HLAO's own domain —
inter-session messaging. If a provider adapter starts using it, HLAO's default JSON and human transcript will
show `raw`/nothing. `user_message_chunk` is likewise a standard way for an adapter to surface a user line.
The default wire contract should not require `--raw` to see message content.

**Fix shape.** Add first-class event types/fields for ACP session messages (`messageId`, `senderSessionId`,
`recipientSessionId`, `content`), render them like `prompt.sent` with the real sender, and render
`user.message` (possibly coalesced) instead of ignoring it. If these are intentionally out of scope, document
that HLAO ignores ACP's inter-session channel, and stop exposing `raw` as if it were a usable projection.
Update the event-type filter help to say which types have no human rendering.

**Effort:** M.

---

### R-13. Provider identity, model, and provenance are not in the human session views — P2

**Type:** missing column/projection. **Delta vs the ledger's “Adapter versions” item:** that item asks for
package/protocol versions in `doctor`/`agents`; this is per-session provider identity, model, and requester in
the session view.
**Evidence.** `session.initialized` JSON contains `agentName:"signal-agent"`, `agentVersion:"9.9.9"`; human
`read` shows only `ACP session ready`. `SessionView` has no `agentName`/`agentVersion`; `list`/`get` do not
show them. The model lives only in `configOptions` (JSON) and `option <id>`; `list --wide` has no MODEL
column, so a fleet mixing models cannot be read at a glance. `createdBy` is recorded (0.8) but is absent from
human `spawn`, `list`, `get`, and `read`’s `session.created` line. `list --wide` could carry REQUESTER and
MODEL without changing the wire.

**Why it matters.** An operator choosing between ten sessions needs to know who/what/model is behind each.
This is not leaf output; it is orchestration state. The 0.8 acceptance said “spawn results name the
requester”, but only JSON does.

**Fix shape.** Add MODEL (the option whose category is `model`), AGENT/VERSION, and REQUESTER to `list --wide`
or a `--fields` projection; include `createdBy` in the `spawn` human line and `session.created`; include
agent name/version and model in `get`’s state block (R-04). Keep the default list narrow.

**Effort:** S.

---

## D. Safety and lifecycle gaps

### R-14. A parked permission can hang forever; there is no timeout or escalation — P1

**Type:** safety/feature gap. **Delta vs N-10/N-11:** N-10 covers per-tool rules, a pending-request queue, and
deny-always; N-11 covers resource bounds and budgets. Neither covers time.

**Evidence.** `config show` defaults expose `waitTimeoutMs`, `sendWaitTimeoutMs`, `startupTimeoutMs`,
`maxEventsPerSession`, `maxEventLogBytes`, `maxEventBytes`, `retainClosedMs` — no permission timeout. A session
with `permissionPolicy: ask` remains `waiting_permission` until an operator answers; `wait --until permission`
only observes. `README.md:225-228` says the HLAO policy is “the guarantee that a request cannot silently
hang”; that is true for `allow`/`deny`, but `ask` is explicitly the gated mode and can hang indefinitely if
the operator is away or the notification is missed. The docs also recommend notification hooks as future
work (ledger), so today nothing pings the operator.

**Why it matters.** Long unattended runs are the target use case. A parked session holds its adapter and
budget with no progress and no alert. The user may return hours later to a turn that never started.

**Fix shape.** Product decision: add `permissionTimeoutMs` (default 0 = park) with explicit auto-deny /
auto-cancel behavior and a recorded event, or at minimum emit a periodic notice at 1m/5m/… and document that
`ask` requires an operator. If timers are excluded by the thesis, make it a caller-owned `wait --until
permission` loop plus a notification example; do not claim the gate cannot hang. Add `permit --all-pending`
already helps, but it needs an operator.

**Effort:** S/M.

---

### R-15. There is no fleet-level live event stream or merged timeline — P1

**Type:** missing feature. **Delta vs the ledger:** broadcast is send-side; `@last`/tags are organization; the
interactive-surface item (P2-0.5-27) is a future client. This is a CLI-level fleet observation affordance
over the 2.1 subscription wire, which already exists but is not exposed.

**Evidence.** `read` takes one id and follows one session; `list --watch` redraws state every interval but
emits no events; `find` is a one-shot search. A new session that appears during a job is invisible until the
caller re-lists and knows to follow it. There is no `hlao watch`, `read --all --follow`, or merged
chronological view.

**Why it matters.** The operator's job in a fan-out is to notice the first worker that needs attention or
reports a shared fact. Requiring one `read --follow` per known id is a client assembly HLAO could provide
without adding a supervisor timer. It is the natural CLI use of the persistent stream added in 0.6.

**Fix shape.** Add a caller-owned `hlao watch [--all|--root S] [--type T] [--grep TEXT]` that lists targets,
follows each with the existing cursor, and interleaves events with session labels; or `read --all --follow`.
Respect the same filters and backpressure. Do not put a timer or an index in the supervisor. A merged
timeline should preserve per-session cursors and report when a session appears/disappears.

**Effort:** M.

---

### R-16. Project config is not discovered from subdirectories — P2

**Type:** configuration ergonomics. **Delta vs P2-0.5-5:** that item covers `config show`/`validate` not
inspecting project config; this is *discovery* of project config from an effective cwd.
**Evidence.** Project root `<proj>/.hlao/agents.json` defines `projfake`. From `<proj>` `agents --cwd .` shows
it; from `<proj>/sub/dir` `agents` does not, and `spawn projfake --cwd .` reports
`unknown backend "projfake"`. `projectBackendsPath(cwd)` is `join(cwd, ".hlao", "agents.json")` with no
ancestor walk (`src/paths.ts:33-35`, `src/config.ts:141`).

**Why it matters.** Monorepos and nested worktrees are normal. The workaround is to know the project root and
pass `--cwd` there, but `spawn --cwd sub` still does not find it, so the flag that selects the session cwd
cannot also select a parent project config.

**Fix shape.** Walk up from the effective cwd to the first `.hlao/agents.json` (optionally stop at a `.git`
boundary), document precedence and the boundary, and add `--no-project-config` for scripts. Keep `agents
--cwd` and `spawn --cwd` consistent.

**Effort:** S/M.

---

### R-17. There is no time-range filtering or regex search — P2

**Type:** missing query affordance.
**Evidence.** `read --since N` is a sequence cursor, not a time; `--grep` is documented as a case-insensitive
literal; `find` has no time or regex flag and inherits the literal `read --grep`. There is no
`--after`/`--before` time or duration, no `--regex`, and no context lines. A long session forces the user to
export JSON and filter externally.

**Why it matters.** “What happened in the last ten minutes?” is the most common operator question during a
long job, and `HH:MM:SS` cursors make that question visible but unanswerable through the CLI.

**Fix shape.** Add `read --after TIME|DURATION` and `--before`, applied to `event.at`; add `--regex` (and keep
literal as the safe default), `--context N`, and the same flags on `find`. Keep cursors authoritative for
follow loops. Document that durations are relative to now and timestamps accept ISO/local.

**Effort:** S/M.

---

### R-18. There is no instance-wide export/backup, though `down` discards everything — P2

**Type:** missing bulk operation. **Delta vs the ledger's export item:** per-session export exists and is not
in question; this is an instance-wide backup that matches `down`'s scope.
**Evidence.** `export <id>` takes one session; `down` warns that it closes live sessions and discards
in-memory history; `down --dry-run` lists targets but cannot save them. The documented recovery path is
“export anything you need before `down`”, which for a ten-session job means a `list --json` + per-id export
script.

**Why it matters.** The moment `down` is needed (shutting down a host, upgrading, cleaning up) is the moment
a multi-session job's history matters most. A per-session export is easy to forget one of.

**Fix shape.** Add `hlao export --all --out DIR` (one file per session plus a manifest) and/or
`hlao down --export DIR --dry-run`. Use the existing paged export; no new store. Report per-session failures
and truncation in the manifest. This is a client assembly, not a supervisor method.

**Effort:** S/M.

---

### R-19. There is no fork/branch primitive — P2 (feature expectation; resume is separate)

**Type:** missing feature. **Delta vs P0-14:** resume continues one lineage after a crash; fork starts a
second lineage from a live context. They share an ACP load path but are different user operations.
**Evidence.** No `fork`, `branch`, or copy of a session's context. P0-14 asks for resume after a crash; even
if that lands, “continue this context in two directions” is a different operation. HLAO records the adapter's
`loadSession` capability in `session.initialized` but does not use it. ACP `session/load` restores a provider
session; whether that creates an independent branch or simply continues the same provider-side state is
adapter-dependent, so a true fork cannot be promised from the capability bit alone.

**Why it matters.** Adaptive orchestration often means exploring two plans from the same context. Today the
operator must spawn a new session and re-explain the state, which reintroduces exactly the information gap the
product is about. Even a documented “new session with the same transcript reference” recipe is better than
silently sharing or losing context.

**Fix shape.** Only call it `fork` if the adapter's load semantics are known to branch. Otherwise add
`hlao spawn --from <id> --transcript FILE|--reference PATH` as a documented assembly: spawn a new HLAO
session, copy policy/mode/config, and pass the source transcript/ledger by reference. If ACP load is
adapter-supported and truly independent, add `hlao fork <id> [--name] [message]` that loads the provider
session into a new HLAO handle and emits `session.forked` with the source id. Keep the original untouched and
state the provider caveat in help.

**Effort:** M/L, dependent on ACP support and the P0-14 recovery contract.

---

### R-20. Queue pause/reorder is absent; cancel is destructive without a dry-run — P2

**Type:** missing control affordance / destructive UX. **Delta vs P2-0.5-6 and P2-0.5-8:** those cover
destructive `close` defaults and the count-only `close --tree`; this is cancel's queue loss and its missing
preview.
**Evidence.** `queue` lists and drops only. `cancel` without `--keep-queue` discards the backlog (help says so,
and the output reports “2 queued messages discarded”); `cancel --keep-queue` stops the turn but lets the next
queued message run immediately. There is no hold/pause, no `queue move`, no priority. Bulk `cancel --status
busy` prints only `cancelled 1 session`, with no names and no `--dry-run` (close has `--dry-run`; cancel does
not).

**Why it matters.** A queued correction cannot be moved ahead of an obsolete prompt; the operator must drop
and re-send, losing the original message identity. Bulk cancel is more destructive than bulk close (it drops
queues) yet has less preview. The default is deliberately chosen in ADR 0005, but the CLI should make the
loss inspectable.

**Fix shape.** Add `queue hold`/`resume` and `queue move <id> <position>` (client-side queue manipulation is
not possible over the current wire, so this may need a small wire addition; alternatively expose
`cancel --keep-queue --hold`). Add `cancel --dry-run` and per-target lines, or make `cancel --keep-queue` the
default and require `--drop-queue` for the destructive form. At minimum, print the dropped previews/ids in
the cancel result. Check bulk `permit` and `policy` against the same shape; a selector acting on several
sessions should always be inspectable before it runs.

**Effort:** M for queue mutations; S for dry-run/output.

---

### R-21. Tables do not adapt to terminal width — P2

**Type:** polish / readability.
**Evidence.** On ten sessions, `list --wide --usage` produces a 237-character longest line; `agents` produces
198. The CWD column always prints the full path, and there is no `process.stdout.columns` handling
(`src/cli` has no width calculation). `list`/`agents` therefore wrap into unreadable rows in an 80- or
120-column terminal. Ledger P2-11 covers `agents` path truncation and P2-23 covers a pager; this is the table
layout itself.

**Fix shape.** Respect terminal width: drop or shorten CWD (basename or tail), middle-truncate names/paths,
and add `--no-cwd` / `--fields` for scripts. Make width-aware output the default in a TTY; keep full-width
output when not a TTY or under `--no-truncate`.

**Effort:** S/M.

---

### R-22. JSON is full-fidelity and pretty, so list/watch payloads scale badly — P2

**Type:** agent ergonomics / payload design.
**Evidence.** `list --json` for ten sessions is 19,813 bytes (~2 KB/session) because every `SessionView`
includes `modes` and the full `configOptions` array. `list --watch --json` repeats that entire object every
interval. There is no `--fields`, `--compact`, or a projection parameter; `--json` is pretty-printed. For an
agent consuming several commands per turn, this is significant context waste; for a dashboard, it is
redundant polling.

**Fix shape.** Add `--fields id,name,status,turn,queued,lastActivityAt,usage` and a compact JSON mode (one
line). By default, omit static `modes`/`configOptions` from list items; fetch them with `get <id>` or
`option <id>`. Let `list --watch --json` emit only changed fields or a documented compact view. Keep the full
view available explicitly.

**Effort:** S/M (CLI projection only; the wire can stay full).

---

### R-23. No usage/cost aggregation, and model is not a list view — P2

**Type:** missing observability. **Delta vs N-11:** N-11 asks for bounds/budget and notes `wait --until
usage`; this is reporting and fleet legibility, not a stop condition.

**Evidence.** `list --usage` shows each session's latest `used/size` and a per-currency cost total. There is no
`hlao usage` command, no per-root/job total, no time-window total, and no per-turn history view beyond paging
raw `usage` events. Model/reasoning effort are config options, not columns. With ten sessions on different
models, the operator cannot answer “what is this job costing and what is each worker running?” from one view.

**Fix shape.** Add `hlao usage [--root S] [--since DUR] [--group session|root|model]` as a client aggregation
over `sessions.list`/`usage` events; add MODEL and COST columns to `list --usage` or `--fields`. Treat token
snapshots as non-additive (already done) and label aggregates. A budget/stop condition remains N-11.

**Effort:** S/M.

---

### R-24. Retained closed sessions poison friendly names — P2

**Type:** addressing/lifecycle. **Delta vs P2-0.5-9:** that item covers duplicate-name validation and
name ergonomics; this is the retention interaction and the missing remedy.

**Evidence.** A closed retained `echo1` and a newly spawned `echo1` both existed; `read echo1`/`get echo1`
returned `ambiguous_id` with both candidates. The closed row lives for `retainClosedMs` (one hour by default).
The error lists the candidates but does not suggest `close --forget <id>` or using the live id. A new spawn
silently created the duplicate in the first place.

**Why it matters.** Reusing a name after close is natural. For an hour, the friendly address stops working
and the operator has to notice the retained row in `list --all`. The error looks like a collision between two
live sessions.

**Fix shape.** Resolve a name preferring a live session when the other matches are terminal (and report the
choice), or release the name at close while keeping it searchable by id; or block duplicate creation with a
clear `--name` error and a `--force-name`/`--forget` hint. Add the remedy to the ambiguity error.

**Effort:** S.

---

### R-25. `find` output is raw JSON, truncated without an ellipsis, and lacks context — P2

**Type:** search usability.
**Evidence.** `find "hello" --all` prints lines like:

```text
q0dgt4  #7  agent.message  {"text":"echo: HLAO skill: read \"C:\\…\\SKILL.md\" (or run \"hlao skill\") befo
```

The preview is `JSON.stringify(event.data).slice(0, 140)` with no `…`, no session name, no timestamp, and no
line context (`src/cli/commands/find.ts:115-119`). When the match limit is reached, the session is added to
`capped`, and the summary says “scan capped”, conflating “hit `--max`” with “stopped after 20 pages”.

**Why it matters.** Search is how an operator finds the one worker that mentioned the failure. A raw JSON
fragment with escaped Windows paths is hard to scan; silent truncation can hide the matched term if it falls
after column 140 (the match is in the data, but the visible preview may not show it).

**Fix shape.** Render a one-line snippet centered on the match, with `…` markers, session name/id, timestamp,
and event title; add `--context` lines; separate `matchLimitReached` from `scanCapped` in the summary. Keep
`--json` for raw data. Add `--regex`/time filters (R-17).

**Effort:** S.

---

### R-26. Human `send`/`spawn` omit the message id except on duplicates — P2

**Type:** contract truthfulness. **Delta vs N-07:** N-07 delivered message ids on the wire and in JSON;
this is the remaining human-output gap for the same feature.
**Evidence.** `help send` says “Every send returns a message id (`msg-…`) that events and queue entries
carry.” Human output for a normal send is `sent to slow1 (954235) (queued behind turn 1)` — no id. Duplicate
output does show it (`already sent msg-…`), and `queue` shows ids while queued. `spawn` first-message output
also omits the id; `spawn` duplicate shows “reused first message msg-…”.

**Why it matters.** The id is needed for `queue drop --id` and for correlating events, and the docs promise it.
A user must switch to `--json` or run `queue` before the message runs.

**Fix shape.** Print `msg-…` in the normal human send/spawn paths (and in `prompt.sent` human rendering, R-02).
Keep the line compact.

**Effort:** S.

---

### R-27. `option <id> <key>` cannot read one option — P2

**Type:** command ergonomics.
**Evidence.** `mode <id>` reads/sets; `policy <id>` reads/sets; `option <id>` lists all and
`option <id> <key> <value>` sets, but `option <id> <key>` errors:

```text
hlao: option takes <id>, <id> <key> <value>, or --self <key> <value>
```

**Why it matters.** Reading the current model/reasoning effort is the most common use, and the full table is
noisy. Symmetry with `mode`/`policy` is expected.

**Fix shape.** Allow `option <id> <key>` to print that option's current value (and metadata); keep
`<key> <value>` for setting. Update help.

**Effort:** S.

---

### R-28. Release metadata and documentation are stale and mutually inconsistent — P2

**Type:** release truthfulness.
**Evidence.**
- `package.json` version `0.5.0`; `package-lock.json` version `0.3.0`.
- `hlao version`, `hlao status`, and `hlao skill --json` all report `0.5.0`; `HLAO_SKILL_VERSION` is
  `0.5.0`.
- `CHANGELOG.md` tops out at `0.7.0 — unreleased`; there are no 0.8/0.9 entries, while
  `docs/milestones/0.8.md` and `0.9.md` exist.
- `docs/context.md` says “Version: 0.5.0 … 134 tests”; milestone 0.9 says 177 tests, and `npm test` covers
  the 0.8/0.9 surface.
- `README.md:408` says “v0.7 speaks ACP v1 only”; the product is at 0.9.
- `CHANGELOG.md` 0.5.0 still says “self-and-descendants visibility enforced”, contradicting universal
  addressing (ADR 0008).
- `contracts/cli.md` omits `doctor --probe` from its command list and `logs --raw`, while the CLI supports
  both.

**Why it matters.** Agents receive `HLAO_SKILL_VERSION=0.5.0` and `hlao status` reports 0.5.0 while behavior
includes 0.8/0.9 features. A package publish or bug report will carry the wrong version. The docs are the
contract for clients; drift there is a client-boundary risk.

**Fix shape.** Do a release-metadata pass: bump package/lock to the intended version, add 0.8/0.9 changelog
entries, refresh `docs/context.md` counts/version, and sweep stale version references. Make the version
source-of-truth check part of CI (package.json == CLI == lock == skill metadata). Decide whether the skill
version is the package version or a separate skill artifact version and say so.

**Effort:** S.

---

### R-29. Auto-name/title is missing; list is dominated by ids — P2

**Type:** missing affordance / list readability. **Delta vs the ledger's tags/groups item:** tags are manual
organization; this is automatic display labeling when the operator supplied no name.
**Evidence.** `SessionView` has no title field; the provider's `session_info_update` is only an event; HLAO's
`name` is operator-supplied at spawn and otherwise absent. A ten-session list shows `—` or no name and long
ids. Nothing derives a label from the first prompt, and `list --wide` has no title column.

**Why it matters.** Names are the operator's memory. In a fan-out, an id-only list forces the operator to
`read` each session to remember what it was doing. The provider often supplies a title for free; the first
prompt is also a useful fallback.

**Fix shape.** Keep operator names authoritative; when absent, use `SessionView.title` from
`session_info_update`, else a truncated first-prompt preview (for example 40 display columns), marked as
derived. Show it in `list`/`get` as a `TITLE` column or as the display name with `--name` overriding. Do not
change addressing: derived labels are display-only.

**Effort:** S/M.

---

### R-30. Small truthfulness and polish items — P3

These are individually small but collectively make the surface feel less finished. None is in the old ledger
unless noted.

| Item | Evidence | Suggested fix |
|---|---|---|
| Closed session says “is closing” indefinitely | `send q0dgt4` after `close` → `session q0dgt4 is closing`; `list`/`get` say `closed` | Use `closed` for terminal, reserve `closing` for an in-flight close (`src/session.ts:894,907,937,972`) |
| Missing-argument grammar | `spawn` with no args → `spawn expects at least 1 positional arguments` | “at least 1 positional argument” or “a backend” (`src/cli/args.ts:169`) |
| `down` singular grammar | `stopping closes 1 live session and discards their in-memory history` | “its” for one; list the session names or suggest `--dry-run` |
| Duplicated config path | `C:\…\config.json: cannot parse C:\…\config.json: …` | Let the inner error omit the filename |
| `send --wait` timeout wording | `busy — the message is still queued behind turn 1`, exit 2, no “timed out” | Say “wait timed out after 1s”; include the message id |
| `wait` timeout rounding | `within 999ms` for `--timeout 1s` | Format with the requested unit or round up |
| Read cursors omit the date | `HH:MM:SS` only; a session spanning midnight is ambiguous | Show the date on the first event of a new day, or point to `--timestamps` |
| Notice severity not shown | `notice › Provider notice — …` regardless of severity | Prefix/color by severity (info/warning/error) |
| Unknown command has no suggestion | `unknown command "frobnicate"` | Offer nearest command names (`help`, `list`, …) |
| `logs` naming collision | `hlao logs` is supervisor diagnostics; session transcript is `read` | Add `logs <id>` as a `read` alias, or rename/document prominently |
| `--cwd` undocumented in list help | Top-level help and README mention it; `help list` documents only `--cwd-prefix` | Add it and explain exact vs prefix |
| State-bearing `raw` labels | `read --type raw` prints bare `raw`; no payload, even with `--verbose` | Print event type + bounded payload or hide `raw` from default human output |
| `--color=always` absent | Only `--no-color`/`NO_COLOR`; piping to `less -R` loses color | Add `--color auto\|always\|never` (or `FORCE_COLOR`) |
| Bidi stripping tradeoff | Bidi controls are stripped from human output; legitimate RTL text can reorder incorrectly | Keep stripping dangerous overrides; consider preserving LRM/RLM or document `--raw` for RTL |
| Prompt text in argv | `send`/`spawn` positional text is visible in process listings and shell history | Document `--stdin`/`--prompt-file` for secrets; add a note to `help send` |
| `agents`/`list` path truncation | Long CWD/command paths consume the row (also P2-11 for agents) | Width-aware columns, basename/tail display (R-21) |

---

## Feature expectation catalog (not in the old ledger)

A compact view of capabilities a user coming from tmux/gh/docker/agent harnesses would look for. Each is
already argued above; this table is for planning, not a second report.

| Expected affordance | Why a user expects it | Current | Suggested shape | Finding |
|---|---|---|---|---|
| Fleet event tail / merged timeline | Monitor a fan-out without following each id | `read` one id; `list --watch` state only | `hlao watch` over list + cursor follow | R-15 |
| Fork/branch a session | Explore alternatives from the same context | No command; P0-14 resume only | `hlao fork` only when ACP load truly branches; otherwise `spawn --from` with a transcript reference | R-19 |
| Queue hold/reorder | Correct the next instruction without losing it | Drop and resend only | `queue hold/resume/move` | R-20 |
| Time-range read/search | “What happened in the last 10m?” | Seq cursors; literal grep | `--after/--before`, `--regex`, `--context` | R-17 |
| Auto title/description | Recognize sessions in a list | Ids and optional names | Provider title or first-prompt fallback | R-29 |
| Model/usage columns and per-job cost | Compare workers and spend | Model only in `option`; usage latest only | `--fields model`, `usage --root` | R-23 |
| Instance-wide export | Back up before `down` | One session at a time | `export --all --out DIR` | R-18 |
| Permission timeout/escalation | Unattended runs cannot park forever | Parks indefinitely | `permissionTimeoutMs` or notification loop | R-14 |
| Project config from subdirs | Monorepos/worktrees | Exact cwd only | Walk up to `.hlao/agents.json` | R-16 |
| Compact/fields JSON | Agents and dashboards pay for full views | Full pretty JSON | `--compact`, `--fields` | R-22 |
| Markdown export | Share a transcript with a human | JSON/JSONL only | `export --format markdown` | R-18 (related) |
| Actor provenance in views | Know who spawned/stopped/renamed | JSON only | REQUESTER column/header | R-01/R-13 |

**Deliberately not requested** (keep the thesis): scheduler, cron, DAG, task store, global registry, kanban,
workflow engine, durable transcript, HTTP API, MCP-only surface, provider subagent surfacing, client
filesystem/terminal capabilities, attachments/content blocks, per-tool permission rules (already N-10),
resource bounds/budget (already N-11), and the existing ledger's addressing/ops items.

---

## Suggested 0.10 sequence

The findings cluster into passes with one design decision each. This is a suggestion, not a scope
commitment.

1. **Truthfulness pass (small, high value).** R-01, R-02, R-03, R-04, R-05, R-06, R-26, R-30, R-31. These
   are mostly renderer/CLI fixes; they make the human surface match the JSON that already exists. Add
   human/JSON parity tests for actor fields and wait exit codes.
2. **Agent-birth pass.** R-08, R-09, plus the skill's root/parent and permission wording. This is a docs and
   one-guard change, but it prevents deadlocked agents.
3. **Provider-state pass.** R-10, R-11, R-12, R-13. Advertise the ACP capabilities the product intends to
   support, project the fields, and add `SessionView` fields. This is the largest feature-shaped item.
4. **Fleet observation pass.** R-15, R-17, R-22, R-23, R-25, R-18. Client assemblies over existing wire
   methods; no new supervisor authority.
5. **Control/lifecycle pass.** R-14, R-20, R-24, R-16, R-19 (dependent on ACP/P0-14), R-21, R-29.
6. **Release hygiene.** R-28 + contract/help sweep, before any publish.

The order is chosen so the first two passes are pure truthfulness/guidance (no wire change), the third is the
only one that needs a capability/wire decision, and the rest are projections/assemblies. None of these adds a
scheduler, store, registry, or second authority.

---

## Method and evidence notes

- **Environment:** Node v26.8.1, Windows 11, branch `milestone/0.9-maintenance`, built `dist/` and
  `dist-test/`. `npm run check` was clean. `npm test` ran 177 tests: 175 pass, 2 skipped (POSIX-only
  process-group tests on Windows), 0 fail, in ~62s. The suite is green, so none of these findings is a
  covered regression.
- **Fake backend:** `dist-test/tests/fixtures/fake-acp-agent.js` configured as a user backend. It exercises
  echo, slow turns, permission parking, cancellation, delayed crash, env reporting, and message/chunk
  coalescing.
- **Signal backend:** a small custom ACP agent (`signal-agent.mjs`, in the job temp directory) that sends
  valid `plan`, `plan_update`, `compaction_update`, `compaction_summary_chunk`, `subagent_update`,
  `available_commands_update`, `notice`, `user_message_chunk`, `session_message`, and
  `session_message_chunk` updates. Its output is the evidence for R-10 through R-13.
- **Human/JSON comparisons** were made with the same command and session; no code changes were made to the
  repo. The custom agent lives outside the repository and is not a deliverable.
- **Limits:** the bundled fake adapter concatenates ACP text blocks with `""`; a real provider may insert a
  newline between blocks. R-09 is therefore phrased as a compatibility/audit risk, not a universal provider
  behavior. Compaction/plan-update findings were reproduced by an adapter that ignores missing client
  capabilities; a compliant adapter will send less, so the observed gap is a lower bound, not an upper one.
  Real provider adapters were not re-probed in this pass; the findings are about the HLAO surface, which the
  fake and signal agents exercise through a real supervisor.
- **Old-ledger adjacency:** R-06 extends P2-0.5-18 (status --start exit 0) to all autostart commands; R-07 is
  the signal/cleanup half of P0-14; R-14 is a time dimension not covered by N-10/N-11; R-23 is reporting, not
  N-11's budget; R-24 is the retention consequence of P2-0.5-9; R-20's dry-run gap is the cancel analogue of
  P2-0.5-8's close-tree count gap; R-21 is table layout, not P2-23's pager.

---

## One-line summary

HLAO's primitives are sound; the next pass should make the human transcript and the session state tell the
truth about **who did what**, **what the provider is doing** (plans, compaction, messages), and **what the
fleet is doing**, before adding more commands.
