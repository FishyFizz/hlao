# HLAO — Remaining feature and usage gaps

**Originally reviewed:** 2026-10-19 (HLAO 0.1.0)
**Updated:** 2026-10-20 after milestone 0.10. The additive 0.10 review was merged here and
deleted after its resolved findings were removed.
**Scope:** unresolved findings only. This is the long-standing ledger. The 0.1–0.4 review, the
0.5 review, and the 0.10 review were merged here; resolved items were removed. Shipped fixes
are described in `docs/milestones/0.2.md` through `docs/milestones/0.10.md` and ADR 0005–0010.

The substrate is unchanged: five primitives, a per-user supervisor, a bounded cursor-addressed
event log, identity at spawn, and one-shot waits. The gaps below are affordances around those
primitives, not requests for a scheduler, store, or registry. Since 0.4 the socket protocol is
the client boundary: a dashboard, TUI, or MCP server is a client, and any capability it needs
must be added to the wire deliberately. 0.6 added framed transport adapters and persistent
streams (protocol 2.1); 0.7 added settled waits, change filters, session activity, and an
optional JSON envelope (protocol 2.2); 0.8 added message identity, the skill at birth,
provenance, and process groups (protocol 2.3); 0.9 was maintenance with no behavior or wire
change; 0.10 finished the truth pass and added crash/injection metadata (protocol 2.4). None of
that changes the primitive set.

0.8 resolved N-07, N-12, N-14, the spawn requester record (part of N-08), P2-36, P2-0.5-26,
P2-53, P2-0.5-3, P2-0.5-14, and P2-0.5-22. Attachments and `--context`/`--ledger` (N-13) are
closed by product decision: the prompt is the only context channel, and it carries verbatim
text or references, never payloads.

0.10 resolved the truth pass: actor attribution and queue identity (R-01, R-02), settled/idle
exit semantics (R-03, R-31), the `get` state block (R-04), `list --cwd` counts (R-05),
fail-fast config startup (R-06), crash signalling (R-07), the worker-loop deadlock and pointer
audit (R-08, R-09), message ids in human output (R-26), release metadata (R-28), the selected
R-30 polish, the documentation half of R-14, and P2-0.5-18. Those entries were removed. The
residual R-13 provider identity item, R-14's mechanism, and every other open 0.10 finding are
below.

---

## P0 — remaining

### P0-14. No resume after an adapter crash `[design tradeoff]`

**Expect:** after an adapter crash or supervisor restart, either resume the session or have a
documented recovery path; at minimum, the loss is signalled.

**Current (0.10):** a failed session is terminal. `read` retains it for `retainClosedMs` (one
hour), `hlao export <id>` pages the full retained history, and `down` warns about live and
retained histories and supports `--dry-run`. A supervisor crash is now signalled: `lastCrash`
in `hello`, `status`, and `doctor`, plus a warning from the next autostarting command, names the
previous pid and states that its live table and retained history were lost. There is still no
`hlao resume` and no ACP `session/load`/`resume` path, so a long job cannot continue after its
adapter process dies.

**Why it matters:** long jobs can lose hours of context. ADR 0002 deliberately rejects a
durable transcript; this is a warm-host recovery gap, not a request for a store.

**Smallest useful fix:** `hlao resume <id>` using ACP `session/load`/`resume` when the adapter
advertises it: spawn a new adapter process, load the provider session, keep the same HLAO
handle, and continue the event log with a `session.resumed` event. Warm-host only; the live
table still owns identity.

**Effort:** L.

---

## P1 — users will hit these

### Agent trust, identity, and reliability

#### N-08. Control is advisory, not enforced

Caller identity is self-declared from `HLAO_SESSION_ID`; a spawned agent can unset it or read
`<HLAO_HOME>/supervisor.json` and call the socket as the operator (`reload`, `shutdown`,
`by: "operator"`). A session with `permissionPolicy: ask` can run `hlao policy --self allow` (or
re-policy a sibling) and remove the gate. 0.8 recorded `createdBy`, and 0.10 made the human
transcript attribute actors truthfully (R-01), but those are provenance and audit, not
authority. There is still no scoped client credential. A stale-caller spawn still becomes an
unrelated root without a warning.

**Why it matters.** The target user drives agents over build logs, repositories, and web
content; those agents read untrusted material. The docs say the token is not an ACL, but the
CLI's `operator_only` errors and the phrase "ask is the gated mode" imply more than the model
delivers.

**Fix shape.** Document the trust model beside `--permission ask` and `operator_only`; decide
whether a stale-caller spawn should warn. For containment, offer a scoped client token/shim
(no raw operator methods, no arbitrary policy changes) or require a separate instance for
untrusted agents. The instance token is the real authority; say so where the controls are
described.

**Effort:** S for docs/warning; L for scoped-client enforcement.

### Permissions and resource bounds

#### N-10. Permission model: one tri-state and one pending request

- **No per-tool rules.** `permissionPolicy` is a single `allow|ask|deny` for the whole session.
  Users expect "allow Read/Grep, ask on Bash, deny destructive commands". Provider modes can
  approximate some of this, but they differ per backend and are opaque to HLAO.
- **One pending request only.** A second concurrent permission request is auto-cancelled with an
  `error` event. Parallel tool calls can therefore have one request silently rejected; the
  session view and the wire cannot represent a queue.
- **No deny-always.** The ACP option kind `reject_always` exists, but `permit --always` is only
  valid with `--allow`. This is the former P2-10 item.

**Fix shape.** Add `permissionRules` matching tool kind/title (and, where the provider exposes
it, command patterns) to a policy; support a bounded pending-request queue with per-request ids
and `permit --request <id>`; allow `--deny --always` to prefer `reject_always`. Keep provider
modes as the lower layer.

**Effort:** M/L.

#### N-11. No resource safety bounds or spend budget

The event log is bounded; the things an agent can create are not. There is no `maxSessions`, no
`maxQueuedPrompts`/`maxQueuedBytes`, and no per-session or per-instance budget. Usage is
retrospective: `SessionView.usage` and `list --usage` show the latest snapshot, but there is no
`wait --until usage` for an operator loop to stop at a cost threshold.

**Fix shape.** Add safety bounds with explicit `bad_request` messages: `maxSessions`,
`maxQueuedPrompts`, `maxQueuedBytes`. Add a budget as an observation/stop condition over the
existing `usage` view, surfaced in `list --usage` and documented as a caller-owned loop. A
budget that stops a job is not a scheduler; the stop condition stays with the caller.

**Effort:** S/M.

#### R-14. A parked permission can hang forever `[from the 0.10 review]`

0.10 removed the false "a request cannot silently hang" guarantee and documented that `ask`
parks until an operator or another session answers. The mechanism is still missing: there is no
`permissionTimeoutMs`, no auto-deny/auto-cancel, and no periodic notice. A session with policy
`ask` holds its adapter and turn budget until someone answers; `wait --until permission` only
observes.

**Why it matters.** Long unattended runs are the target use case. The operator may return hours
later to a turn that never started.

**Fix shape.** Product decision: add `permissionTimeoutMs` (default 0 = park) with explicit
auto-deny/auto-cancel behavior and a recorded event, or at minimum emit a periodic notice and
document that `ask` requires an operator. If timers are excluded by the thesis, make the
caller-owned `wait --until permission` notification loop the documented pattern. `permit
--all-pending` helps, but it needs an operator.

**Effort:** S/M.

### Provider-native state (from the 0.10 review)

This is the largest feature-shaped gap. The wire carries ACP signals, but HLAO both fails to ask
for the interesting ones and then throws away their structure. It is the only remaining pass
that changes ACP client capability advertisement.

#### R-10. Context compaction is invisible by construction — P1

HLAO's ACP `initialize` advertises only `session.configOptions.boolean`. It does not advertise
`session.compaction`, `session.notices`, or `plan`, so a compliant adapter is told not to send
the signals an operator needs on a long job. When a custom agent sent valid compaction updates
anyway, HLAO stored `{"type":"compaction","data":{}}` and human `read` printed a bare
`compaction` line. Default JSON drops the private payload; `SessionView` has no compaction
field, `get`/`list` show nothing, and there is no context-pressure warning. The only context
signal is the latest `usage` snapshot.

**Why it matters.** Long-running jobs are exactly where an agent hits its context limit.
Compaction is the moment its memory changes; an operator who cannot see it cannot tell why a
previously reliable agent started forgetting the task.

**Fix shape.** Advertise `session.compaction` (and `session.notices`) and project
`compactionId`, status, summary/error into first-class event data. Add `SessionView.compaction`
and a `context` summary; render `compaction › started/completed · summary`; add a
context-pressure warning as an event/notice, not a timer. Add `wait --until compaction` only if
the event is reliable; otherwise document a caller loop over usage. Do not implement a
scheduler.

**Effort:** M.

#### R-11. Plan deltas and provider session titles never reach the session view — P1

A valid `plan_update` produced JSON with the whole plan under `data.update.plan`, but human
`read` printed only `plan.update`; `plan_removed` loses `planId`. The initial `plan` event is
rendered well; only deltas are invisible. `session_info_update` is rendered as `session › title`
but the title is not stored in `SessionView`, so `get`/`list` cannot show it. HLAO also does not
advertise the experimental `plan` capability, so a compliant adapter may never send deltas.

**Why it matters.** The current plan is the closest thing to "what is the agent doing next?"
and a title is the cheapest way to distinguish ten sessions. Both are already on the wire and
both are missing from the state view.

**Fix shape.** Project the latest plan into `SessionView.plan` (entries plus updatedAt) and the
latest title into `SessionView.title`; render plan changes as diffs or a compact
`plan › 2/5 done · current: …`; use the provider title as a fallback label in `list` (operator
name wins). Advertise `plan` if deltas are wanted, and document that experimental updates are
opt-in. Keep `plan_removed` carrying `planId`.

**Effort:** M.

#### R-12. ACP inter-session messages and user-message chunks are dropped or hidden — P1

A valid `session_message` and `session_message_chunk` were projected as generic `raw` with
`data:{}`; the ACP fields (`messageId`, `senderSessionId`, `recipientSessionId`, `content`)
survive only under `--raw`. Separately, `user_message_chunk` maps to `user.message` with
text/messageId, but the human renderer has a bare `break`, so filtering `read --type
user.message` prints a header and no events.

**Why it matters.** ACP's experimental `session_message` is a protocol-level version of HLAO's
own inter-session messaging. If a provider adapter starts using it, HLAO's default JSON and
human transcript show `raw`/nothing. `user_message_chunk` is a standard way to surface a user
line. The default wire contract should not require `--raw` to see message content.

**Fix shape.** Add first-class event types/fields for ACP session messages, render them like
`prompt.sent` with the real sender, and render `user.message` (possibly coalesced) instead of
ignoring it. If these are intentionally out of scope, document that HLAO ignores ACP's
inter-session channel and stop exposing `raw` as a usable projection. Update the event-type
filter help to say which types have no human rendering.

**Effort:** M.

#### R-13 (residual). Provider agent name and version are not in the session view — P2

0.10 added MODEL and REQUESTER to `list --wide`, `createdBy` to the spawn/read views, and model
and requester to `get`. The remaining gap is provider identity: `session.initialized` JSON
carries `agentName` and `agentVersion`, but `SessionView` has neither, so `get`/`list` cannot
show which adapter and version produced the state.

**Fix shape.** Add `agentName`/`agentVersion` to `SessionView` in the provider-state pass and
show them in `get`'s state block and an `AGENT`/`VERSION` column or `--fields` projection.

**Effort:** S.

### Fleet observation (from the 0.10 review)

#### R-15. There is no fleet-level live event stream or merged timeline — P1

`read` takes one id and follows one session; `list --watch` redraws state every interval but
emits no events; `find` is a one-shot search. A new session that appears during a job is
invisible until the caller re-lists and knows to follow it. There is no `hlao watch`, `read
--all --follow`, or merged chronological view.

**Why it matters.** The operator's job in a fan-out is to notice the first worker that needs
attention or reports a shared fact. Requiring one `read --follow` per known id is a client
assembly HLAO could provide without adding a supervisor timer. It is the natural CLI use of the
persistent stream added in 0.6.

**Fix shape.** Add a caller-owned `hlao watch [--all|--root S] [--type T] [--grep TEXT]` that
lists targets, follows each with the existing cursor, and interleaves events with session
labels; or `read --all --follow`. Respect the same filters and backpressure. Do not put a timer
or an index in the supervisor. A merged timeline should preserve per-session cursors and report
when a session appears/disappears.

**Effort:** M.

### Addressing and session identity

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| `@last` / `last` | Quick return to the most recent session | None | Alias to the most recently active visible session |
| Tags/groups | Organize parallel jobs beyond cwd | Names, cwd, and cwd-prefix filters only | `--tag` at spawn, `list --tag`; a flat label |
| Broadcast/announce | `PRODUCT.md` calls announcement `list + send × n` | The caller writes the loop | `send --tree <id>` assembly or an example helper |

R-24 (retained closed names) is in the 0.10 table below; it is the retention interaction that
complements P2-0.5-9.

### Observability

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| Pending duration | Know how long a session has been blocked | `get` and the pending header show `requestedAt` age; `list --wide`/`status` still show only the title | Compute blocked-for in `list --wide`/`status` |
| `--quiet` | Script without chatter | None | Suppress human hints |

### Control and lifecycle

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| Interrupt-and-send | Replace a running turn with a new instruction | Manual `cancel` + `send` | `send --interrupt` assembly |
| Per-turn timeout | Stop a hung turn | `--timeout` bounds the wait, not the turn | Documented cancel assembly, or `--turn-timeout` with product sign-off |
| Resume | Recover a crashed session | None (see P0-14) | ACP load/resume, warm-host only |

### Operations and configuration

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| `hlao init` / `config init` | Scaffold user or project config | Hand-write JSON | Write an example config with validation |
| `hlao restart` | Upgrade/clean restart | `down`, then the next command | Explicit command with a loss warning |
| `doctor --cwd DIR` | Check a project config | Uses the process cwd | Add the flag |
| Adapter versions | Diagnose drift | Doctor shows the supervisor version; `agents` shows command paths | Adapter package versions and protocol version (see R-13 residual) |
| Project policy/timeouts | Per-repo gating | Project schema accepts only `backends` | Extend the project schema deliberately |
| Per-backend defaults | A backend may imply cwd/mode/policy | All per spawn | Manifest defaults with CLI override |
| Env interpolation | Portable configs | Literal strings only | `${VAR}` and `~` expansion with explicit rules |
| Default backend | Avoid repeating the backend name | Required every spawn | `defaultBackend` in user config |
| Config schema | Editor validation/autocomplete | None | Ship JSON Schema and reference it |
| Shell completion | Normal CLI expectation | None | bash/zsh/fish/PowerShell |
| Command aliases | Muscle memory | None | `ls`, `rm`, `ps`, `tail` |
| Global autostart control | Scripts may want failure instead of launch | Session commands autostart; `status`/`doctor` opt in | Global `--no-start` |
| Doctor writability checks | Home/log/socket permissions | Not checked | Check and report |
| Worktree example | Parallel coding workers need isolation | None | Document `--cwd` + worktree recipe |
| Notification hooks | Long jobs need alerts | None; 0.10 documents the operator-owned `wait --until permission` loop | Optional `--exec` |
| Fan-out/fan-in example | Parallel workers are a core shape | Four assemblies, no fan-out | Add `examples/acceptance/fanout.mjs` |
| Update check | Know when the CLI is stale | None | Compare packaged version; optional self-update |

### Agent ergonomics and integration

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| `hlao` on PATH inside a session | Agents should not need a global install just to call the CLI | `HLAO_CLI` is injected; a global install is otherwise required | Inject a shim directory or make `doctor` assert a global install |
| MCP server configuration | Session-scoped tools are common | Adapters use their own config; ACP `mcpServers` is not exposed | `spawn --mcp FILE`, adapter-dependent |
| Schema introspection | Agents building commands | Contracts only | `hlao schema --json` |
| MCP wrapper | Tool-native agent integration | Deliberately absent | Optional wrapper, never the only surface |

---

## P2 — remaining polish and edge cases

IDs beginning with `P2-0.5-` come from the 0.5 review; the other numbers preserve the original
0.1–0.4 numbering. Items resolved in 0.7, 0.8, and 0.10 were removed. The R-xx items below are
the unresolved remainder of the 0.10 review; their IDs are preserved for traceability.

- **P2-2 — String options can still swallow a following flag.** Path, number, and duration
  options are strict, but e.g. `spawn --name --json` accepts `--json` as the name. Reject
  flag-like values for string options, or document that `--name=--json` is the escape hatch.
- **P2-11 — `agents` left-truncates command paths.** CONFIG paths are middle-truncated; the
  COMMAND column still cuts into a directory name. Use middle truncation or a basename. See
  also R-21.
- **P2-23 — No pager or wrapping.** A large read page or long tool title floods the terminal.
  See also R-21.
- **P2-33 — `agents` does not show configured environment keys.** `AgentView.envKeys` exists;
  the human table omits it. Add an `ENV` column or `--show-env` (never values).
- **P2-0.5-1 — Leading global flags are incomplete.** `hlao --no-color list` and `-h` before a
  command still misparse; only `--json`, `--json-envelope`, and `--home` are handled as leading
  globals. Handle the full global set or document command-only placement.
- **P2-0.5-4 — Secret exposure in backend args.** `agents`/`config show` redact env values but
  print args; `--token secret` in args is visible. Redact known secret flags or warn.
- **P2-0.5-5 — Project config inspection is incomplete.** Runtime errors name
  `.hlao/agents.json` (0.7), but `config show`/`validate` still inspect only user config and
  have no `--cwd`. Add project config support and name the file everywhere. See also R-16.
- **P2-0.5-6 — Destructive defaults.** Inside a session, `close` with no id closes self;
  `close --idle`/`--status idle` includes the caller unless `--except-self`. Make self-close
  explicit or exclude self from bulk cleanup by default.
- **P2-0.5-7 — Tree forget needs two passes.** `close --root X --forget` on a tree with a
  terminal root and live child closes the child then fails to forget the root; `--tree
  --forget` is rejected. Allow one-shot tree forget or document the two-pass rule.
- **P2-0.5-8 — `close --tree` prints only a count.** List the closed ids/names or suggest the
  dry run.
- **P2-0.5-9 — Name ergonomics.** No duplicate-name warning; a name may start with `-`
  (unaddressable without `--`), contain newlines/control chars, or equal an id. Validate or
  warn; document `--`. See also R-24.
- **P2-0.5-11 — `logs` has no filters.** `--raw` and human sanitization landed in 0.7, but
  `--level` and `--grep` are still missing. See also R-30's `logs` naming collision.
- **P2-0.5-12 — Inert flags are silent.** `--interval` without `--watch`, `--sort` with
  `--tree`, `--timestamps` with `--json`, and `--wide` with `--json` are silently ignored.
  Warn like `spawn --timeout` does.
- **P2-0.5-13 — Read flag semantics drift.** `--timestamps` does nothing under `--json`;
  `--verbose` + `--json` unexpectedly includes raw payloads; `--raw` in human mode also enables
  payload rendering. `--jsonl-page` was added in 0.7; align the rest.
- **P2-0.5-16 — Remaining age/time inconsistencies.** 0.10 shows the date on the first event
  of a new day, but the `--watch` header uses UTC ISO while `read` uses local time, and the
  usage event prints `42/200000` while the list formats `42.0k`. Standardize.
- **P2-0.5-17 — Inner JSON shapes still differ.** `--json=envelope` (ADR 0010) gives one outer
  shape, but `mode` read returns a raw modes object while set returns `{session}`, and `agents`
  uses `{agents}` while the wire uses `{backends}`. Align the inner payloads at 1.0 or document
  them as stable per-command shapes.
- **P2-0.5-19 — Retention expiry is indistinguishable from never-existed.** After
  `retainClosedMs`, a session is `not_found`; `list --all` shows no expiry. Distinguish
  `expired` or include remaining retention.
- **P2-0.5-21 — Message blocks split across follow pages.** `read --follow` renders per page; a
  streamed agent message split at a page boundary becomes two blocks with different cursors.
  Carry message-id state across pages.
- **P2-0.5-23 — `queue drop` collides with a session named `drop`.** The first positional is
  treated as a subcommand. Use a flag (`queue --drop N`) or `--id`.
- **P2-0.5-24 — Help topics are incomplete.** Unknown-command suggestions landed in 0.10, but
  `hlao help version` is still unknown, `-h` before a command prints full help rather than that
  command's, and `-a`, `-n`, `-f` are undocumented.
- **P2-0.5-27 — No interactive surface.** The wire is ready for a dashboard or TUI (2.1 adds
  persistent streams). Build one client before adding more core features.

### From the 0.10 review

| ID | Finding | Current | Suggested shape | Effort |
|---|---|---|---|---|
| R-16 | Project config is not discovered from subdirectories | `projectBackendsPath(cwd)` joins the effective cwd with `.hlao/agents.json`; from `<proj>/sub` neither `agents` nor `spawn --cwd .` finds the root config | Walk up to the first `.hlao/agents.json` (optionally stop at `.git`), document precedence, add `--no-project-config` | S/M |
| R-17 | No time-range filtering or regex search | `read --since N` is a sequence cursor; `--grep` is a literal; no `--after`/`--before` time, `--regex`, or `--context` | Add time/duration filters over `event.at`, opt-in `--regex`, context lines, and the same flags on `find` | S/M |
| R-18 | No instance-wide export/backup, though `down` discards everything | `export` takes one session; `down --dry-run` cannot save | `export --all --out DIR` with a manifest, and/or `down --export DIR`; report per-session failures and truncation | S/M |
| R-19 | No fork/branch primitive | No `fork`; ACP `loadSession` is recorded but unused; resume is separate | Only call it `fork` if ACP load truly branches; otherwise `spawn --from` with a transcript reference and copied policy/mode/config | M/L |
| R-20 | Queue pause/reorder is absent; cancel is destructive without a dry-run | `queue` lists and drops only; plain `cancel` discards the backlog; bulk cancel prints a count only | `queue hold`/`resume`/`move` (may need a small wire addition); `cancel --dry-run` and per-target output; print dropped previews | M for queue; S for dry-run |
| R-21 | Tables do not adapt to terminal width | `list --wide --usage` produces a 237-character line; `agents` 198; no `process.stdout.columns` handling | Drop/shorten CWD, middle-truncate, add `--no-cwd`/`--fields`; width-aware by default in a TTY, full width otherwise | S/M |
| R-22 | JSON is full-fidelity and pretty, so list/watch payloads scale badly | `list --json` is ~2 KB/session because every view carries `modes` and `configOptions`; `--watch --json` repeats it every interval | Add `--fields` and compact JSON; omit static options from list items; let watch emit changed fields; keep full view explicit | S/M |
| R-23 | No usage/cost aggregation | `list --usage` shows the latest snapshot and a per-currency cost total; 0.10 added MODEL to `list --wide`, but there is no `hlao usage`, per-root/time-window total, or COST column | Add `hlao usage [--root] [--since] [--group session\|root\|model]` and a COST column; keep token snapshots non-additive; a budget remains N-11 | S/M |
| R-24 | Retained closed sessions poison friendly names | A retained closed `echo1` and a new `echo1` make `read echo1` ambiguous for `retainClosedMs`; the error suggests neither the live id nor `--forget` | Prefer a live match, release the name at close, or block duplicate creation with a remedy; add the remedy to the error | S |
| R-25 | `find` output is raw JSON, truncated without an ellipsis, and lacks context | Preview is `JSON.stringify(data).slice(0, 140)`, no session name/timestamp/context; "scan capped" conflates `--max` with the 20-page cap | Render a centered one-line snippet with `…`, name/id, time, and event title; add `--context`; separate the cap reasons; reuse R-17 filters | S |
| R-27 | `option <id> <key>` cannot read one option | `option <id>` lists all and `<key> <value>` sets, but `<key>` alone errors | Allow reading one option's value and metadata; update help | S |
| R-29 | No auto-name/title | `SessionView` has no title; provider `session_info_update` is only an event; no first-prompt fallback | Keep operator names authoritative; use provider title or a truncated first-prompt preview as a display-only fallback | S/M |
| R-30 | Residual polish | `hlao logs` collides with session transcript naming; no `--color=always`; bidi controls are stripped (RTL tradeoff) | Add a `logs <id>` alias or document the distinction; add `--color auto\|always\|never`; document/soften the bidi tradeoff | S |

---

## Suggested sequence

The remaining work is grouped so each milestone has one design decision:

1. **0.8 — agent at birth and reliability.** Shipped.
2. **0.9 — maintenance.** Shipped.
3. **0.10 — truth before features.** Shipped; resolved the truth pass and merged its review
   here. See `docs/milestones/0.10.md`.
4. **0.11 — provider-native state.** R-10..R-12 and the R-13 residual: advertise and project
   ACP compaction, notices, plans, titles, and inter-session messages. This is the only
   remaining ACP-capability decision.
5. **0.12 — fleet observation and bulk operations.** R-15, R-17, R-18, R-21, R-22, R-23, R-25,
   R-29.
6. **Safety and policy.** N-08 enforcement, N-10, N-11, and R-14's mechanism. This may move
   ahead of 0.12 if risk dominates.
7. **Ergonomics and control tail.** R-16, R-19, R-20, R-24, R-27, and the remaining P2 items.
8. **Resume.** P0-14 on its own; it needs ACP `session/load`/`resume` and a recovery contract.
9. **Surfaces.** Dashboard/TUI/MCP over the 2.1 persistent streams, plus the 0.6 transport
   policy work (opt-in loopback TCP, TLS/credential rules, WebSocket adapter).
10. **1.0 — contract freeze.** Decide whether `--json=envelope` becomes the default, align the
    remaining inner JSON shapes, finish package/update metadata, and document the multi-instance
    ("project home") ergonomics.

Resist adding a scheduler, DAG, task store, or global registry. The items above are projections,
bounds, client assemblies, and trust decisions; they do not create a second authority. A
"budget" that stops a job, a "permission rule" that answers a request, and a "job wait" that
loops are all within the existing model as long as the stop condition remains caller-owned and
the answer is recorded as an event.

---

## Note

Everything above remains outside the implemented 0.10 surface. The implementation and its tests
are described in `README.md`, `contracts/`, and `docs/milestones/0.2.md` through
`docs/milestones/0.10.md`. 0.10 resolved the truth pass, then merged the 0.10 review into this
ledger and deleted `FEATURE-REVIEW-0.10.md`.
