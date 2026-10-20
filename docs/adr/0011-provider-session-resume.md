# ADR 0011 — Provider session resume and fork, not an HLAO transcript store

**Status:** accepted, 2026-10-21.

## Context

ADR 0002 bounded the event log in memory and reported eviction through `truncated`. That is
honest, but it left the architecture with an unbuilt half. `PRODUCT.md` says *the live
provider sessions are the state*, and `STACK.md` Q2 says *ACP can reconstruct
lists/history/resume*. The implementation did neither: it held an in-memory projection and
treated the provider session id as internal (`agentSessionId` was "diagnostics only").

The test that resolved the question: an agent using HLAO must have what a human using the
harness has, nothing less and nothing more. A human can resume a Claude Code session and see
its full history. The agent could not. The primitive was present — the adapters advertise
ACP `session/load`, `session/resume`, and `session/list` — so this was a missing exposure,
not a missing feature.

## Decision

- The **provider session id is the durable job handle**. It is returned in the spawn result
  as `SessionView.agentSessionId`, printed by human `spawn`, and shown by `get`.
- The **HLAO session id is an alias** for the supervisor's lifetime. No HLAO-side session
  index, registry, or pointer store is added.
- `spawn --resume <providerSessionId>` reopens the provider session with ACP `session/load`.
  Replayed events are marked `replay: true`; a `session.resumed` event records the provider
  id and the replayed seq range.
- A backend that lacks `loadSession` is refused with `spawn_failed`. Starting an empty
  conversation under a resumed id would be a lie.
- A resume for a provider id already held by a live HLAO session returns that session
  (`duplicate: true`) instead of opening a second adapter against the same transcript.
- `spawn --fork <providerSessionId>` copies the provider session with ACP `session/fork`.
  The source is untouched and keeps its id. When the backend also advertises `loadSession`,
  the copy is loaded immediately so its history is replayed like a resume; otherwise
  `session.forked` reports `historyLoaded: false`. Fork and resume are mutually exclusive.
  A live-table lookup is not used to dedupe forks, because each call is meant to create a
  new session.
- Recovery is the spawner's job, not the supervisor's. The spawning agent keeps the provider
  id in its own durable context; after a restart it passes it back. The interrupted turn is
  not replayed, so the caller re-issues the prompt, exactly as a human would after resuming.

## Alternatives rejected

- **A durable HLAO transcript.** ADR 0002's reasoning stands: it would become a second
  authority after a crash. The provider already owns the transcript; HLAO reads it.
- **Persisting an HLAO session index.** The harness already catalogs sessions by cwd, and the
  spawner's own context already records the provider id. A side table would be "more" than a
  human uses.
- **Backfilling history into the original seq space.** Replay creates new events. Pretending
  they are the original seqs would make `earliestRetainedSeq` a fiction. Marking them as
  replay is the honest projection.

## Consequences

- `truncated` no longer means "lost forever"; it means "this view holds a bounded tail".
  The remedy is a resume, and a client with the `spawn.resume` capability can offer it.
- The live log stays bounded. A transcript larger than retention evicts its own earliest
  replay events, and reports that honestly.
- A fork is visible as a new session with `forkedFrom`; the source gains no event and no
  lineage edge. HLAO's `parentId` remains the agent-hierarchy relation, not a fork graph.
- Orphaned adapter processes after a hard kill remain a hazard: two adapters could resume the
  same provider session. The live-table check prevents this while a supervisor is alive; the
  hard-kill case is the existing operational limitation, not a reason to add a lease system.
