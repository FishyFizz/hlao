# ADR 0014 — Provider session discovery is a read of the provider, not an HLAO registry

**Status:** accepted, 2026-10-21.

## Context

ADR 0011 made the provider session id the durable job handle: `spawn --resume`
reopens it with ACP `session/load`, and the spawner keeps the id in its own
context. That left a gap the 0.12 review recorded as RF-04: a client that did
not spawn the session — a human opening the dashboard after a restart, or
another agent — had no HLAO way to discover provider sessions. Both bundled
adapters advertise ACP `session/list`, but HLAO exposed no verb. A human could
run `claude --resume` and pick from a list; an HLAO client could not.

The obvious-looking fix is a persisted registry mapping provider sessions to
HLAO sessions (or to names and lineage). That would reintroduce the second
authority the product excludes: the provider owns conversation lifecycle, so a
local map would be a cache that is stale the moment the provider deletes,
archives, moves, or re-authenticates a session. It would also persist an HLAO
id that is deliberately only an alias for one supervisor's lifetime. The map
would be per-home while provider ids are provider-global: incomplete if local,
overreaching if global.

## Decision

- **Expose the provider's catalog as a read.** `backends.sessions` calls ACP
  `session/list` for a backend and an optional absolute cwd. It is
  capability-gated on the adapter's `sessionCapabilities.list` and returns
  provider rows plus the next cursor. The read starts a short-lived adapter
  process; it creates no HLAO session and no provider conversation, and it
  writes no mapping.
- **Join the live table, do not persist it.** For each provider row, the
  supervisor looks for a non-terminal HLAO session whose `agentSessionId` is
  the provider id and reports `attached`, `hlaoSessionId`, `hlaoName`, and
  `hlaoStatus`. A row with no attachment is `provider-only`; clients must not
  present it as an HLAO session.
- **Adoption is a client assembly.** `hlao adopt` reads the catalog, finds the
  row, and calls `sessions.spawn` with `resumeSessionId` (or `forkSessionId`
  with `--fork`). The new session gets a new HLAO id, name, parent/root, and
  environment. No old HLAO identity or lineage is restored.
- **The provider row supplies the cwd.** An explicit `--cwd` that disagrees
  with the row is refused rather than allowed to split the transcript. If the
  row is not found, an explicit `--cwd` is the caller's assertion and the
  provider load remains the authority; with neither, the command refuses
  rather than guessing.
- **Reattach keeps the provider's mode.** A resumed or forked conversation
  keeps the mode the provider reports. `backends.<name>.defaultMode` applies
  to new sessions only; an explicit operator `--mode` still wins.
- **No automatic tree recovery.** Recover one agent at a time. The root's own
  transcript or a user-space ledger carries the child provider ids; a
  registry-derived tree is the cold-host reconstruction the design excludes.

## Alternatives rejected

- **A persisted provider-to-agent registry.** It would be a second authority
  over which sessions exist, stale against provider lifecycle, ambiguous about
  the lifetime-scoped HLAO id, and scoped per home while provider ids are not.
  The provider's `session/list` already is the registry; read it.
- **A durable HLAO session index or lineage file.** ADR 0011 and ADR 0003
  already rejected these. The live table is the address space; lineage is
  delivered at spawn and held by the spawner.
- **A global, cross-instance registry.** It violates ADR 0008's instance
  boundary and cannot be enforced without a cross-process lease the design
  does not want.
- **Tagging the provider title with the HLAO id.** Provider titles are
  display-only, provider-specific, and not a portable identity channel. A
  user-space ledger or the export manifest is the honest place for historical
  correlation.
- **Persisting the provider catalog locally.** Caching an external authority
  is the same staleness problem with an extra invalidation burden. A client
  may cache operator state locally, labelled not-live, but the supervisor does
  not.

## Consequences

- Provider enumeration is now a human/agent parity feature: both can see the
  provider's sessions and adopt one, using the same live table as the address
  space.
- The catalog may include sessions HLAO did not create. They are labelled
  provider-only and can be adopted explicitly; they are never silently claimed.
- Historical HLAO names and lineage are still not recoverable from the
  provider catalog. `export --all` / `down --export` and user-space ledgers
  remain the durable, operator-owned record. Enriching the export manifest
  with the provider id is a natural follow-up, not a registry.
- The catalog read costs one adapter start. A client disconnect or supervisor
  shutdown aborts the request and kills the probe; no adapter is left behind.
- HLAO cannot detect another client or another HLAO home driving the same
  provider session. `--fork` is the safe move when the source must stay
  untouched; coordination is a trust protocol, not a lock.
- RF-04 is resolved. RF-05 is resolved for the adoption path; `spawn --resume`
  remains the raw primitive and trusts the caller's cwd, with the help naming
  the original-cwd requirement. RF-01, RF-02, RF-03, RF-06, RF-07, and RF-08
  remain provider-continuity hardening.
