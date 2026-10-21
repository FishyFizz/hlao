# ADR 0013 — The provider owns permission policy; HLAO relays

**Status:** accepted, 2026-10-21. Supersedes the policy mechanism in ADR 0004; the
observability and pending-request decisions in that ADR stand.

## Context

HLAO grew a second permission policy beside the provider's native mode: a per-session
`allow|ask|deny` setting that auto-answered, parked, or rejected ACP permission requests.
The provider already owns the tool semantics and the permission mode; HLAO saw only the
request, not the tool, the command, or the mode's meaning.

The duplication had a cost. `allow` had to be the default because Manual mode asks before
every tool call and an agent then hung. Per-tool rules would have required HLAO to learn
every adapter's tool taxonomy. A handler graph and policy inheritance would have invented
an authority relation on top of a policy that was already redundant. Every layer made
`ask` mean something different.

The target user drives agents over logs, repositories, and untrusted content. A person using
the provider chooses a mode and answers the provider's prompts. HLAO should do the same,
not simulate a second policy engine.

## Decision

- **There is no HLAO permission policy.** `permissionPolicy`, `sessions.set_policy`, and
  `policy.changed` are removed.
- **The provider's mode is the coarse policy.** Operators set a per-backend `defaultMode`;
  an operator `--mode` at spawn or a live `mode` change overrides it. Agents cannot choose
  a mode.
- **Every provider ask is forwarded to the operator.** The supervisor queues the ACP
  request, exposes it in `pendingPermissions`, and answers only when the operator `permit`s
  it. There is no auto-allow or auto-deny.
- **Control is operator-only.** `sessions.permit`, `sessions.set_mode`, and a spawn `mode`
  from an agent are refused with `operator_only`. Reads remain open.
- **The pending queue is bounded.** Parallel requests queue (FIFO, default 16); a full
  queue fails closed; `permit --request` and `--all-pending` answer them.
- **The wait is bounded.** `permissionTimeoutMs` (default 30m, `0` = park) is a one-shot
  deadline per request; expiry selects a reject option, else cancels; never allows.
- **`permit --always` is a provider option selector.** It selects `allow_always` or
  `reject_always`; it does not mutate HLAO state.
- **Protocol 3.0 is a clean break.** The policy surface is removed, the dashboard moves in
  lockstep, and a live supervisor of another major is reported rather than replaced.

## Alternatives rejected

- **Keep `permissionPolicy` and add per-tool rules.** HLAO lacks the tool taxonomy and the
  provider mode already expresses the same intent differently per backend. It would be a
  second policy engine with worse information.
- **A handler graph (ask the parent, choose a handler, inherit).** It makes `ask` mean
  "delegate," creates cycles and closed-handler fallbacks, and turns lineage into authority
  even though lineage is caller-supplied and unauthenticated.
- **Freeze and inherit `permissionPolicy`.** Same duplication; the freeze is better applied
  to the provider mode and the operator's permit.
- **Keep the auto-`allow` default.** It was a workaround for the provider's Manual mode, not
  a policy HLAO can own. The operator now sets a default mode or answers.
- **Keep one pending request and reject a second (ADR 0004).** Once every ask is forwarded,
  parallel tool calls make that a silent cancellation of real work. A bounded queue is the
  relay's plumbing, not a new authority.
- **A compatibility shim that keeps `permissionPolicy` inert.** A field that says nothing is
  worse than a clean major break before 1.0.

## Consequences

- Permission behavior is provider-specific. HLAO exposes `modes`/`configOptions` but does
  not normalize them. The operator chooses each backend's default and answers the rest.
- Unattended runs require an operator-set `defaultMode` (or accepting the provider's
  default). Otherwise the provider asks and the operator is the gate; the timeout bounds it.
- The operator is the only answerer. A parent agent cannot unblock a child; it reports the
  blocker. The skill is updated.
- Operator-only enforcement is advisory: caller identity is self-declared and the instance
  token is readable by same-user agents. N-08's scoped credential or a separate instance is
  still required for containment.
- The wire moves to 3.0; the dashboard and all clients must update together.
- ADR 0004's observability rule remains: a request is orchestration state, visible in the
  log, view, and `wait --until permission`. Only the policy layer and the one-request limit
  are superseded.
