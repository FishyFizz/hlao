# ADR 0005 — One serialized turn per session; cancel clears the queue

**Status:** accepted, 2026-10-19.

## Context

Agents drive each other. A parent may send a message while a child is mid-turn. ACP does not
define concurrent prompt semantics across adapters, and interleaving two turns in one
session would make the event log ambiguous and the session's behavior provider-dependent.

Separately, `session/cancel` stops the active turn but says nothing about messages the client
has not sent yet.

## Decision

- Each session runs at most one `session/prompt` turn at a time. `send` while busy appends to
  a visible FIFO queue (`SessionView.queued`, `prompt.queued` events).
- When a turn ends, the next queued prompt is dispatched automatically and gets the next turn
  number.
- `cancel` requests ACP `session/cancel`, resolves a pending permission as cancelled, and
  settles every queued prompt as `cancelled` with `cancelledBeforeStart: true`. A
  `prompt.discarded` event per prompt records it.
- `send --wait` waits for the turn produced by that message only. A timeout does not cancel.

## Alternatives rejected

- **Reject sends while busy.** Forces every caller to build a retry loop and loses the
  message if it is not retried. The queue is the human behavior: type while the agent works.
- **Allow concurrent prompts.** Adapter-dependent, makes turn attribution ambiguous, and
  turns the log into an interleaving no reader can reconstruct.
- **Cancel only the active turn, keep the queue.** Pressing stop and having the next message
  start immediately is not a stop; it also makes the operator's intent unexpressible.
- **Cancel the whole session/process.** `cancel` must be graceful and preserve the session;
  `close --force` is the hard halt.

## Consequences

- Queue depth is part of the orchestration state and is bounded only by memory; a runnable
  caller can enqueue many messages. This is visible, not hidden.
- A parent that sends and never waits can build a queue; `list` shows it.
- The settled outcome of a discarded prompt is explicit, so a waiting caller is never left
  hanging.
