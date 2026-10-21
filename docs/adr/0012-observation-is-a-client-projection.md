# ADR 0012 — Fleet observation is a caller-owned projection

**Status:** accepted, 2026-10-21.

## Context

0.12 made the provider transcript the recovery authority. The remaining observation gaps
were about seeing the fleet, not about owning more state: there was no merged live stream, no
time/regex/context search, no whole-instance export, no usage aggregation, and no output
that adapted to a terminal or to a script. Each could be "solved" by giving the supervisor a
watch loop, a search index, a usage store, or a smaller canonical list payload.

That would undo the substrate. ADR 0001 keeps one supervisor per user, ADR 0002 keeps a
bounded per-session event log, and ADR 0009 defines subscriptions over the existing frames.
The supervisor's job is to own sessions and report state; the client's job is to assemble a
view.

## Decision

- **The supervisor gains no timer, index, search store, merged timeline, or usage database.**
  `hlao watch`, `hlao usage`, `hlao find`, `hlao export --all`, table width, and column
  projection are all caller-owned loops over `sessions.list`, `sessions.read`, and
  `stream.subscribe`.
- **Subscriptions remain the push primitive.** `hlao watch` holds one fleet subscription,
  chunked to the wire's 100-id limit, keeps per-session cursors, and resubscribes when a
  session appears or disappears. The CLI reconnects with the same cursors; the supervisor
  does not reconnect on the client's behalf.
- **History is not replayed by watch.** A session present at start is followed from its
  current cursor. A session discovered mid-stream is attached from seq 0 so its first prompt
  and turn are not lost; the cursor dedupe keeps the replay bounded. Retained history remains
  the job of `read` and `export`.
- **Search stays a projection over the bounded log.** Time bounds, regular expressions, and
  context neighbors are added to `sessions.read`; they scan the retained events and add no
  index. `find` remains a bounded client loop over that read, with explicit cap reasons and
  per-session errors.
- **Context is display-oriented.** `--context` bounds matches by `limit`, adds neighbors, and
  reports `matchedSeqs`. Page cursors still advance by matches, so a neighbor may repeat on
  the next page. That is preferable to a cursor that could skip a match.
- **Usage aggregation is derived, not stored.** Total cost is additive per currency; context
  is a per-session snapshot and is never summed. A time window reads the latest `usage` event
  per session inside the window, bounded by retention.
- **The wire grows only where the data is not already client-side.** Protocol 2.8 adds the
  read time/regex/context filters and `SessionView.firstPrompt`. It does not shrink
  `sessions.list`; the dashboard reads provider modes and config options from list views.
  `list --compact` and `--fields` are CLI output projections.
- **A budget is still a caller-owned stop condition.** `hlao usage` observes; N-11's bounds
  and a stop-at-threshold loop remain separate work.

## Alternatives rejected

- **A supervisor `watch` method or server-side merged stream.** It would need a timer and a
  fan-in owner, and it would duplicate what `stream.subscribe` already delivers. It also makes
  filtering the server's policy rather than the caller's.
- **A search index.** The log is bounded (5,000 events / 16 MiB by default). A scan is
  predictable, has no invalidation problem, and keeps eviction visible.
- **A usage/cost store.** Cost already arrives as a provider snapshot. A store would become a
  second authority and would need persistence rules ADR 0002 deliberately avoids.
- **Shrinking `sessions.list` by default.** It would break the dashboard's Inspector and
  StateStrip, which read `modes` and `configOptions` from list views. The CLI can project its
  own output without changing the wire contract.
- **Exporting inside the supervisor on shutdown.** `down --export` runs the existing client
  export first and refuses to stop on failure; the supervisor still owns only shutdown.

## Consequences

- Observation improves without changing the primitive set or the authority model.
- A watch client must do its own chunking, cursor bookkeeping, dedupe, and reconnect. The CLI
  pays that cost once; the wire stays simple.
- `read --context` may repeat a neighbor across pages; clients that need exactly-once should
  use `matchedSeqs` and their own dedupe.
- A time-windowed `usage` report is limited by retained events. Truncation is visible through
  the normal read result, not hidden by an aggregate.
- The dashboard can consume the new additive fields without a wire bump of its own; its
  protocol document is updated alongside the core contract.
