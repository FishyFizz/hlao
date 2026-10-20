# HLAO — Remaining feature and usage gaps

**Originally reviewed:** 2026-10-19 (HLAO 0.1.0)
**Updated:** 2026-10-20 after milestones 0.2 through 0.7.
**Scope:** unresolved findings only. Resolved items were removed; the original review is in git
history, and the shipped fixes are described in `docs/milestones/0.2.md` through
`docs/milestones/0.7.md`, ADR 0005 (amendment), ADR 0006, ADR 0007, ADR 0009, and ADR 0010.

The substrate is unchanged: five primitives, a per-user supervisor, a bounded cursor-addressed
event log, identity at spawn, and one-shot waits. The gaps below are affordances around those
primitives, not requests for a scheduler, store, or registry. Since 0.4 the socket protocol is
the client boundary: a dashboard, TUI, or MCP server is a client, and any capability it needs
must be added to the wire deliberately.

---

## P0 — remaining

### P0-14. No resume after an adapter crash `[design tradeoff]`

**Expect:** after an adapter crash or supervisor restart, either resume the session or have a
documented recovery path; at minimum, the loss is signalled.

**Current (0.4.0):** a failed session is terminal. `read` retains it for `retainClosedMs` (one
hour), `read --out FILE` exports a page, `down` warns before stopping, and `close --help`
documents the loss. There is still no `hlao resume` and no ACP `session/load`/`resume` path, so a
long job cannot continue after its adapter process dies.

**Why it matters:** long jobs can lose hours of context. ADR 0002 deliberately rejects a
durable transcript; this is a warm-host recovery gap, not a request for a store.

**Smallest useful fix:** `hlao resume <id>` using ACP `session/load`/`resume` when the adapter
advertises it: spawn a new adapter process, load the provider session, keep the same HLAO
handle, and continue the event log with a `session.resumed` event. Warm-host only; the live
table still owns identity.

**Effort:** L.

---

## P1 — features users will still expect

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

Original numbering is preserved for traceability.

- **P2-2 — String options can still swallow a following flag.** Path, number, and duration
  options are strict, but e.g. `spawn --name --json` accepts `--json` as the name. Reject
  flag-like values for string options, or document that `--name=--json` is the escape hatch.
- **P2-11 — `agents` left-truncates command paths.** CONFIG paths are now middle-truncated; the
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

---

## Note

Everything above remains outside the implemented 0.7 surface. The implementation and its tests
(166 across unit, end-to-end, and acceptance) are described in `README.md`, `contracts/`, and
`docs/milestones/0.7.md`.
