# ADR 0002 — Cursor-addressed, bounded reads; no durable transcript

**Status:** accepted, 2026-10-19.

## Context

`PRODUCT.md` open question 1 is the one that can sink the design: what does read/observe
report, and how does it separate knowable orchestration state from judgement? `STACK.md`
fixes the substrate: ACP's typed `session/update` stream, cursor-addressed and bounded, with
orchestration state projected separately from leaf output.

The temptation is a transcript file or table. That would make the log the authority, create
a store the design must keep true, and invite cold-host reconstruction — all excluded.

## Decision

- Each live session owns an in-memory event log with strictly increasing per-session `seq`.
- Reads take `since` (exclusive) or default to a tail window, and always take a `limit`.
- Retention is bounded by count and approximate bytes. Eviction is reported, never silent:
  `earliestRetainedSeq` and `truncated`.
- One oversized ACP payload is stored as a flagged preview (`data.rawTruncated`) rather than
  evicting the rest of the log.
- A read page is bounded by bytes as well as count. A single event larger than the page
  budget is returned alone rather than dropped; paging continues through `hasMore`.
- Reads return a **projection**: orchestration fields in `SessionView`, typed events in
  `EventView`. `raw: true` adds the original ACP update under `data.raw`.
- Nothing is persisted. A supervisor restart loses history, by design.

## Alternatives rejected

- **Durable JSONL transcript per session.** It would become the source of truth after a
  crash, which means lineage reconstruction and a second authority. It also silently grows
  without bound unless retention is added — at which point it is the same bounded log with
  more failure modes.
- **Full snapshots on every read.** Unbounded and duplicative; makes `since` meaningless and
  hides whether a reader missed events.
- **Streaming `read --follow`.** A persistent subscription is useful but it is a second
  delivery mechanism; a bounded read plus a one-shot `wait --until change` composes into a
  poll loop the caller controls. Adding a stream now would create an untested secondary path.
- **Acks/consumption cursors.** Reads are pure; a second consumer (the operator watching an
  agent's session) must not steal the agent's events.

## Consequences

- Long sessions lose their earliest events. The operator sees `truncated: true` and the
  earliest available cursor, which is an actionable boundary rather than an invisible one.
- Reads are cheap and safe to repeat.
- Leaf judgement remains the caller's: the log says what happened, not whether a build
  passed.
