# ADR 0004 — Permission requests are observable orchestration state

**Status:** accepted and revised, 2026-10-19.

## Context

ACP agents may send `session/request_permission` while a prompt turn is running. If the
client answers invisibly, or lets the request hang with no operator-visible trace, a job
stops making progress for a reason nobody can see. That is the failure class HLAO exists to
remove.

## Revision after real-provider use

The first cut defaulted to `ask`. A real Claude Code session showed why that default is
wrong: the adapter starts in its Manual permission mode and asks before every `Bash` tool
call. A normal agent then parks on its first tool call, and again on each subsequent one,
unless a human answers every prompt. The default reproduced the invisible-stuck-job failure
this product exists to remove — through the product's own default.

The revision:

- **Default policy `allow`.** Requests are answered with the first allow option and recorded
  (`by: policy:allow`). The request stays visible in `read`; it does not park the turn.
- **`ask` is opt-in.** `--permission ask` at spawn or in config keeps the full gate.
- **`hlao permit <id> --allow --always`** answers the current request and switches that live
  session's policy to `allow`. When the provider offers an `allow_always` option, it is
  preferred, which can stop the provider from asking at all for matching commands.
- **Provider modes are exposed.** `spawn --mode ID`, `hlao mode <id>`, and
  `hlao mode <id> ID` read and switch the adapter's native modes (Manual, Accept edits,
  Plan, Auto, Bypass where allowed). The provider can then stop asking at the source, which
  is better than answering every request quickly.

The original decision's substance stands: requests are orchestration state, the operator can
answer them, and they must never be invisible. Only the default and the escape hatches move.

## Decision

- Every permission request is observable: `SessionView.pendingPermission`,
  `permission.requested`, and `wait --until permission`.
- Policy `allow` (default) answers with the first allow option and records
  `permission.resolved { by: "policy:allow" }`.
- Policy `ask` stores the request, surfaces it, and blocks the ACP turn — or, for a request
  raised outside a turn, parks the session in `waiting_permission` — until answered.
- Policy `deny` answers with a reject option.
- `hlao permit` answers with an explicit option; `--allow`/`--deny` pick the first compatible
  kind, `--option ID` names one, and `--always` also switches the session policy to allow.
- The provider's own permission mode is a separate, exposed control (`session/set_mode`).
- Cancel and close resolve any pending request as `cancelled` so the adapter is not left
  waiting forever.

## Alternatives rejected

- **Keep `ask` as the default and rely on `--permission allow`.** Rejected after real use:
  the default is what ordinary sessions get, and it parked an agent on every tool call.
- **Default the provider to `auto` or `bypassPermissions`.** Rejected: provider-specific,
  and it would override the operator's own Claude Code settings. Expose the mode instead.
- **Auto-deny by default.** Makes agents fail for an invisible reason, which is worse than
  either allowing or blocking visibly.
- **A permission queue per session.** ACP permits at most one outstanding permission request
  per prompt turn in practice; modeling a queue would invent a concept the protocol does not
  have. The session records one pending request and rejects a second with an event.
- **Treating permission as a leaf event only.** It is orchestration: it changes whether the
  job can progress and who is allowed to unblock it.

## Consequences

- `status: waiting_permission` is a first-class state in `list`.
- A gated session still leaves the job visibly parked, never silently dead.
- A default session does not hang on its first tool call; the request remains in the event
  log with the policy that answered it.
- Agents that drive other agents can decide per session: `--permission allow` for trusted
  work, `--permission ask` when a human gate is wanted, and `permit --always` to remove the
  gate from a session that is already running.
- Provider modes are visible in the session view (`modes`) and its header, so "why is it
  asking?" has an answer.
