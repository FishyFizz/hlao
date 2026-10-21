# ADR 0015 — Spawn receipts are historical, not a live registry

**Status:** accepted, 2026-10-21.

## Context

ADR 0011 made the provider session id the durable handle: `spawn --resume`
reopens it with ACP `session/load`, and the spawner keeps the id in its own
context. ADR 0014 then made the provider catalog readable and adoption a client
assembly.

That still leaves one concrete recovery gap. A leader agent spawns child
agents, the machine reboots, and the operator resumes the leader from its
provider conversation. The new HLAO instance is empty: all HLAO ids, names,
and lineage are gone. The leader remembers that it delegated a job, but it
needs the child's backend and provider id to reopen that child. Today the only
carrier is the leader's own provider transcript (the `hlao spawn` output) or a
user-space ledger. Context compaction can lose it, and an unplanned reboot
means no export was taken.

A live provider-to-agent registry remains rejected for the reasons in ADR
0014: it would be a second authority over provider lifecycle, stale as soon as
the provider deletes or moves a conversation, and scoped per home while
provider ids are not. The missing piece is narrower: a historical receipt of
which provider conversation a parent attached, keyed by the only parent
identity that survives a reboot.

## Decision

- **Append a spawn receipt when a parent attaches a child.** On a successful
  `sessions.spawn` or duplicate reattach, the supervisor appends one JSON line
  to `<HLAO_HOME>/spawn-ledger.jsonl`:
  `{version, at, parentProviderId, parentSessionId, childProviderId,
  childSessionId, backend, cwd, name}`. The parent is the explicit
  `--parent`, or the agent caller when none is given. An operator spawn with
  no parent (or a parent whose adapter reports no provider id) writes nothing.
- **Key recovery by the parent provider id.** HLAO ids are aliases for one
  supervisor's lifetime. The provider id is the durable handle, so a resumed
  leader can resolve its own provider id (`hlao get --self`) and read the
  receipts written by its pre-restart self.
- **`hlao children` is the read surface.**
  `hlao children [--provider ID | --self] [--json]`.
  `--self` resolves the caller's provider id through `sessions.get`;
  `--provider ID` reads the ledger directly and needs no supervisor. The JSON
  result is `{parentProviderId, ledger, children}`.
- **History is not liveness.** Receipts never enter the live table, never
  claim a child is running, and never restore HLAO ids, names, parent/root, or
  depth. Adoption still goes through `hlao adopt <backend> <provider-id>`
  and follows ADR 0014: the provider row supplies the cwd, an already-live
  attachment returns a duplicate, and `--fork` is the copy path.
- **Tolerate a partial file.** Reads skip malformed and truncated lines. The
  same parent/backend/child triple coalesces to its latest receipt, so a
  re-adoption updates the historical cwd/name without producing duplicate
  rows in the result. The ledger file is re-read on each command; it is not
  loaded into supervisor state.
- **A ledger failure never fails a spawn.** The supervisor logs a warning and
  continues. Recovery then falls back to the parent's own transcript or the
  provider catalog.
- **The export manifest carries the durable id.** `export --all` and
  `down --export` now include `agentSessionId` in each manifest entry. The
  per-session export already carried the full `SessionView`; the index did not.

## Alternatives rejected

- **A live provider-to-agent registry.** Rejected for the ADR 0014 reasons. A
  receipt says only "this attachment happened"; it does not answer "is this
  child running?", which is the live table's job.
- **Tagging provider titles with HLAO ids.** Provider titles are
  display-only, provider-specific, and possibly rewritten. They are not an
  identity channel.
- **Injecting a child manifest into every agent environment.** It would be a
  snapshot that goes stale on the next spawn, and it would make the parent's
  environment an orchestration source. The ledger is queried on demand
  instead.
- **Synthesizing a message into the parent's provider conversation.** It would
  survive through the transcript, but it injects HLAO bookkeeping into the
  provider's turn and can be compacted away anyway.
- **Automatic job-tree reconstruction.** The ledger deliberately supports
  manual recovery, one provider id at a time. Restoring handles, names, and
  lineage automatically is still cold-host reconstruction the design excludes.

## Consequences

- A resumed leader has a provider-id-based recovery path that does not depend
  on provider transcript fidelity or an export taken before the reboot.
- The ledger grows without bound; it is small JSON lines and is diagnostic
  rather than authoritative. Neither the supervisor nor the wire reads it as
  state.
- Receipts exist only for spawns and adoptions observed by this home after the
  feature. An older history, a deleted ledger, or a spawn whose parent had no
  provider id still falls back to the parent's own transcript or the provider
  catalog.
- The ledger is per `HLAO_HOME`. Resuming the leader in a different home does
  not bring the receipts with it.
- A leader that was **forked** rather than resumed gets a new provider id, so
  `children --self` does not find its predecessor's receipts. The operator or
  leader must pass the source provider id: `children --provider <source-id>`.
- `children --provider` works while the instance is down, which is the state
  after a reboot until the operator resumes the leader.
