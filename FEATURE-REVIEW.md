# HLAO — Remaining feature and usage gaps

**Originally reviewed:** 2026-10-19 (HLAO 0.1.0)
**Updated:** 2026-10-20 after milestones 0.2 through 0.7.
**Scope:** unresolved findings only. This is the long-standing ledger. The 0.1–0.4 review and
the 0.5 review were merged here, resolved items were removed, and `FEATURE-REVIEW-0.5.md` was
deleted after the merge. Shipped fixes are described in `docs/milestones/0.2.md` through
`docs/milestones/0.7.md` and ADR 0005, ADR 0006, ADR 0007, ADR 0009, and ADR 0010.

The substrate is unchanged: five primitives, a per-user supervisor, a bounded cursor-addressed
event log, identity at spawn, and one-shot waits. The gaps below are affordances around those
primitives, not requests for a scheduler, store, or registry. Since 0.4 the socket protocol is
the client boundary: a dashboard, TUI, or MCP server is a client, and any capability it needs
must be added to the wire deliberately. 0.6 added framed transport adapters and persistent
streams (protocol 2.1); 0.7 added settled waits, change filters, session activity, and an
optional JSON envelope (protocol 2.2). None of that changes the primitive set.

The 0.5 review's truthfulness P0s (dry-run, idle, export, down), the truth pass
(list/read/help/sanitization/examples), and its job-shaped assemblies (wait/cancel/permit/policy
selectors, `get`, `find`) landed in 0.7 and are not repeated here.

---

## P0 — remaining

### P0-14. No resume after an adapter crash `[design tradeoff]`

**Expect:** after an adapter crash or supervisor restart, either resume the session or have a
documented recovery path; at minimum, the loss is signalled.

**Current (0.7):** a failed session is terminal. `read` retains it for `retainClosedMs` (one
hour), `hlao export <id>` pages the full retained history, `down` warns about live and retained
histories and supports `--dry-run`, and `close --help` documents the loss. There is still no
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

### Agent trust, identity, and reliability (from the 0.5 review)

#### N-07. `send` and `spawn` have no message identity or idempotency

`SendResult` reports a turn number but no message id. Queue items have position, sender,
preview, and age, but no id; prompt events have text and sender but no id. A sender that does
not use `--wait` cannot ask "did **my** message run, or is it still queued?" except by matching
preview text. A client that times out after the supervisor enqueued a message and then retries
can enqueue the same prompt twice; the same applies to `spawn` after a lost response.

**Fix shape.** Add optional `messageId`/`idempotencyKey` to `sessions.send` and
`sessions.spawn`, echo it in the result, the `prompt.sent`/`prompt.queued` events, and queue
items; dedupe a repeated key for a bounded window in the live session. This is live-session
state, not a store. `send` should return the id even when the message is queued.

**Effort:** M.

#### N-08. Attribution and control are advisory, not enforced

The most important conceptual gap. Spawn has no actor: `session.created` records backend, cwd,
name, mode, lineage, and policy, but not who requested the spawn. Caller identity is
self-declared from `HLAO_SESSION_ID`; a spawned agent can unset it or read
`<HLAO_HOME>/supervisor.json` and call the socket as the operator (`reload`, `shutdown`,
`by: "operator"`). A session with `permissionPolicy: ask` can run `hlao policy --self allow` (or
re-policy a sibling) and remove the gate. A stale-caller spawn silently becomes an unrelated
root.

**Why it matters.** The target user drives agents over build logs, repositories, and web
content; those agents read untrusted material. The docs say the token is not an ACL, but the
CLI's `operator_only` errors and the phrase "ask is the gated mode" imply more than the model
delivers.

**Fix shape.** Record `createdBy`/`by` on `session.created` and the spawn result; document the
trust model beside `--permission ask` and `operator_only`; warn on a stale-caller spawn. For
containment, offer a scoped client token/shim (no raw operator methods, no arbitrary policy
changes) or require a separate instance for untrusted agents. The instance token is the real
authority; say so where the controls are described.

**Effort:** S for events/docs; L for enforcement.

#### N-12. Agents are not onboarded at birth; the name drifts

A fresh child inherits `HLAO_SESSION_ID`, `HLAO_NAME`, `HLAO_PARENT_ID`, `HLAO_ROOT_ID`,
`HLAO_DEPTH`, `HLAO_BACKEND`, `HLAO_HOME`, and `HLAO_CLI`, but no brief saying what they mean or
which moves it has. The README's agent section is documentation for the human operator; nothing
puts it in front of the agent. Separately, `rename` changes the live view and event log but not
the process environment: after a rename the agent's own `HLAO_NAME` is stale, and `whoami`
reports the environment.

**Fix shape.** Inject `HLAO_BRIEF` (a path or compact text) at spawn, or add `hlao brief` and
make the default spawn prompt include a one-line pointer. Add `spawn --context FILE` /
`--ledger FILE` to inject a reference into the joining prompt and environment. Document that
`HLAO_NAME` is birth-time only, or have `whoami` resolve the live name through the supervisor.
Warn when a stale caller becomes a root (see N-08).

**Effort:** S/M.

#### N-13. Prompts are text-only; no attachments or system prompt

The ACP prompt is a single `{ type: "text", text }` block. There is no `--attach`, no
image/resource content, no MIME handling, and no `--system`/instructions file. `--prompt-file`
reads text; it does not attach a file by reference or content.

**Fix shape.** Add an additive `attachments` or ACP content-block array to `sessions.send` and
`sessions.spawn`, with adapter capability checks; CLI `--attach FILE` (repeatable) and
`--system-file FILE` where the adapter supports it. Keep text as the default and do not
advertise filesystem/terminal capabilities to the provider.

**Effort:** M.

#### N-14. Unix force-close does not take the adapter's descendants

On Windows, `close --force` and the normal close fallback call `killProcessTree`, with a
dedicated test. On Unix, the code sends `SIGTERM` and then `SIGKILL` to the adapter PID only.
Provider tools that spawn shell/build processes can survive the adapter, leaving a build running
after `hlao close --force` or `hlao down`.

**Fix shape.** Spawn adapters in their own process group and signal the group, or implement the
platform-specific tree walk used on Windows. Add a POSIX test with a spawned child process.
Document the behavior until fixed.

**Effort:** M.

### Permissions and resource bounds (from the 0.5 review)

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
`wait --until usage` for an operator loop to stop at a cost threshold. (The misleading token sum
was fixed in 0.7: `list --usage` now labels per-session context and only totals cost.)

**Fix shape.** Add safety bounds with explicit `bad_request` messages: `maxSessions`,
`maxQueuedPrompts`, `maxQueuedBytes`. Add a budget as an observation/stop condition over the
existing `usage` view, surfaced in `list --usage` and documented as a caller-owned loop. A
budget that stops a job is not a scheduler; the stop condition stays with the caller.

**Effort:** S/M.

### Addressing and session identity

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| `@last` / `last` | Quick return to the most recent session | None | Alias to the most recently active visible session |
| Tags/groups | Organize parallel jobs beyond cwd | Names, cwd, and cwd-prefix filters only | `--tag` at spawn, `list --tag`; a flat label |
| Broadcast/announce | `PRODUCT.md` calls announcement `list + send × n` | The caller writes the loop | `send --tree <id>` assembly or an example helper |

### Observability

| Feature | Why expected | Current | Suggested shape |
|---|---|---|---|
| Pending duration | Know how long a session has been blocked | `pendingPermission.requestedAt` is in the view; human output shows the title, not the age | Compute blocked-for in `list --wide` / `status` |
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
| Adapter versions | Diagnose drift | Doctor shows the supervisor version; `agents` shows command paths | Adapter package versions and protocol version |
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
| Notification hooks | Long jobs need alerts | None | Document a `wait`-based example; optional `--exec` |
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
0.1–0.4 numbering for traceability. Items resolved in 0.7 were removed.

- **P2-2 — String options can still swallow a following flag.** Path, number, and duration
  options are strict, but e.g. `spawn --name --json` accepts `--json` as the name. Reject
  flag-like values for string options, or document that `--name=--json` is the escape hatch.
- **P2-11 — `agents` left-truncates command paths.** CONFIG paths are middle-truncated; the
  COMMAND column still cuts into a directory name. Use middle truncation or a basename.
- **P2-23 — No pager or wrapping.** A large read page or long tool title floods the terminal.
- **P2-33 — `agents` does not show configured environment keys.** `AgentView.envKeys` exists;
  the human table omits it. Add an `ENV` column or `--show-env` (never values).
- **P2-36 — `whoami` does not validate a stale `HLAO_SESSION_ID`.** It reports the environment
  as-is. Add a live check or a `live: false` field.
- **P2-50 — Package metadata lacks `repository`, `homepage`, and `bugs`.** Minor distribution
  polish.
- **P2-53 — A queued message cancelled before it starts returns exit 0.** `send --wait` reports
  `stopReason: "cancelled"` with `completed: true`; scripts may treat it as success. Add a
  distinct code or a machine-readable outcome.
- **P2-0.5-1 — Leading global flags are incomplete.** `hlao --no-color list` and `-h` before a
  command still misparse; only `--json`, `--json-envelope`, and `--home` are handled as leading
  globals. Handle the full global set or document command-only placement.
- **P2-0.5-3 — Backend readiness means "command exists".** A Windows `.cmd`/`.ps1` or npm shim
  is READY but `spawn` can return `internal: spawn EINVAL`. Mark unsupported wrappers
  unavailable with a reason, support them safely, or rename READY to PRESENT.
- **P2-0.5-4 — Secret exposure in backend args.** `agents`/`config show` redact env values but
  print args; `--token secret` in args is visible. Redact known secret flags or warn.
- **P2-0.5-5 — Project config inspection is incomplete.** Runtime errors now name
  `.hlao/agents.json` (0.7), but `config show`/`validate` still inspect only user config and
  have no `--cwd`. Add project config support and name the file everywhere.
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
  warn; document `--`.
- **P2-0.5-11 — `logs` has no filters.** `--raw` and human sanitization landed in 0.7, but
  `--level` and `--grep` are still missing.
- **P2-0.5-12 — Inert flags are silent.** `--interval` without `--watch`, `--sort` with
  `--tree`, `--timestamps` with `--json`, and `--wide` with `--json` are silently ignored.
  Warn like `spawn --timeout` does.
- **P2-0.5-13 — Read flag semantics drift.** `--timestamps` does nothing under `--json`;
  `--verbose` + `--json` unexpectedly includes raw payloads; `--raw` in human mode also enables
  payload rendering. `--jsonl-page` was added in 0.7; align the rest.
- **P2-0.5-14 — Partial text is hidden on timeout.** `send --wait`/`spawn --wait` on timeout
  print "still running" but hide the partial agent text that JSON already contains.
- **P2-0.5-16 — Remaining age/time inconsistencies.** ACTIVITY and CREATED landed in 0.7, but
  the `--watch` header uses UTC ISO while `read` uses local `HH:MM:SS`, and the usage event
  prints `42/200000` while the list formats `42.0k`. Standardize.
- **P2-0.5-17 — Inner JSON shapes still differ.** `--json=envelope` (ADR 0010) gives one outer
  shape, but `mode` read returns a raw modes object while set returns `{session}`, and `agents`
  uses `{agents}` while the wire uses `{backends}`. Align the inner payloads at 1.0 or document
  them as stable per-command shapes.
- **P2-0.5-18 — `status --start` with an invalid config exits 0.** It prints "running" plus a
  config error. Add a `healthy` flag or `--strict` exit.
- **P2-0.5-19 — Retention expiry is indistinguishable from never-existed.** After
  `retainClosedMs`, a session is `not_found`; `list --all` shows no expiry. Distinguish
  `expired` or include remaining retention.
- **P2-0.5-21 — Message blocks split across follow pages.** `read --follow` renders per page; a
  streamed agent message split at a page boundary becomes two blocks with different cursors.
  Carry message-id state across pages.
- **P2-0.5-22 — Spawn-wait failure leaves no recovery hint.** If the two-phase human
  `spawn --wait` send fails, the session remains and the CLI does not suggest
  `close`/`read`.
- **P2-0.5-23 — `queue drop` collides with a session named `drop`.** The first positional is
  treated as a subcommand. Use a flag (`queue --drop N`) or `--id`.
- **P2-0.5-24 — Help topics are incomplete.** `hlao help version` is unknown; `-h` before a
  command prints full help rather than that command's; `-a`, `-n`, `-f` are undocumented.
- **P2-0.5-26 — No agent "mine" view or project-home story.** An agent's natural view is its
  root subtree, but `list` defaults to the whole instance; the CLI has no `--mine` or
  ergonomic per-project home. Add `--mine`/`--root $HLAO_ROOT_ID` and document a per-project
  home recipe.
- **P2-0.5-27 — No interactive surface.** The wire is ready for a dashboard or TUI (2.1 adds
  persistent streams). Build one client before adding more core features.

---

## Suggested sequence

The remaining work is grouped so each milestone has one design decision:

1. **0.8 — agent at birth and reliability.** N-07, N-08 (docs + scoped client), N-12, N-13,
   N-14.
2. **0.9 — safety and policy.** N-10, N-11.
3. **Resume.** P0-14 on its own; it needs ACP `session/load`/`resume` and a recovery contract.
4. **Surfaces.** Dashboard/TUI/MCP over the 2.1 persistent streams, plus the 0.6 transport
   policy work (opt-in loopback TCP, TLS/credential rules, WebSocket adapter).
5. **1.0 — contract freeze.** Decide whether `--json=envelope` becomes the default, align the
   remaining inner JSON shapes, finish package/update metadata, and document the multi-instance
   ("project home") ergonomics.

Resist adding a scheduler, DAG, task store, or global registry. The items above are
projections, bounds, client assemblies, and trust decisions; they do not create a second
authority. A "budget" that stops a job, a "permission rule" that answers a request, and a "job
wait" that loops are all within the existing model as long as the stop condition remains
caller-owned and the answer is recorded as an event.

---

## Note

Everything above remains outside the implemented 0.7 surface. The implementation and its tests
(166 across unit, end-to-end, and acceptance) are described in `README.md`, `contracts/`, and
`docs/milestones/0.7.md`.
