# ADR 0006 — A child may send to its direct parent

**Status:** accepted, 2026-10-19 (milestone 0.3).

## Context

`PRODUCT.md` describes bounded ignorance as actionable by "reading the ledger, asking the
parent, spawning an investigator". The shipped scope rule made "asking the parent" impossible:
a child sees itself and its descendants, so `send`, `read`, and `wait` on `HLAO_PARENT_ID` all
failed as outside scope. Delegation was strictly one-way, and the documentation claimed a move
the supervisor refused.

The scope rule also carries the halt authority: visibility is not a security boundary, but it
is the coordination rule for who may read and stop what. Widening it casually would change the
product, not just an affordance.

## Decision

- `sessions.send` may target the caller's **direct parent** when normal scope resolution fails.
  The target must be the parent's exact id or name, or a prefix that uniquely identifies it.
- Nothing else widens. `read`, `wait`, `cancel`, `close`, `permit`, `policy`, `mode`, `option`,
  and rename on an ancestor remain `forbidden`.
- Prompt events record the sender (`prompt.sent.from`, `prompt.queued.from`). A parent sees
  which child spoke; an operator sees `operator`.
- The upward message enters the parent's normal FIFO queue, so it is visible, bounded, and
  subject to the same one-turn-at-a-time rule.

## Alternatives rejected

- **Give children ancestor visibility.** That would also grant read and halt authority, turning
  the upward channel into a bidirectional scope change.
- **A new `notify-parent` primitive.** It would append without starting a turn and needs its own
  delivery semantics. A parent that is busy already has a queue; reusing `send` is smaller.
- **Amend the product claim instead.** The "ask the parent" move is part of the thesis, and the
  supervisor already knows the parent handle. Refusing it was an implementation limit, not a
  decision anyone had made.

## Consequences

- Delegation can report findings and ask blocking questions without waiting for a poll.
- A child can add work to its parent's queue. The parent's `queued`, `queue`, and prompt
  events show the sender, so the queue is not anonymous.
- Authority still follows visibility: a child cannot read, stop, or re-policy its parent.
- Only the direct parent is reachable; grandparents and siblings remain outside scope.
