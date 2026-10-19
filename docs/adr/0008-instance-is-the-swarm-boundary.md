# ADR 0008 — The HLAO instance is the swarm boundary

**Status:** accepted, 2026-10-20 (milestone 0.5). Supersedes the scope decision in ADR 0003,
ADR 0006, and `PRODUCT.md` Q6.

## Context

Q6 resolved session enumeration as **self-and-descendants**. The intent was coordination, not
security: an agent should not touch sessions that are none of its business, and a parent's
knowledge of its descendants is the handles it holds. The supervisor enforced that boundary on
every `sessionId`.

The correspondence rule says the human and the agent use the same moves. A person with the
harness can attach to, read, and stop any session it can name; the self-and-descendants rule
invented a boundary a harness does not have. It also turned the spawn ledger into an authority:
being someone's parent determined what you could see and stop.

The product does need a hard boundary somewhere. Two swarms working on unrelated projects must
be able to stay out of each other's way. That boundary is the deployment unit, not the parent
link.

## Decision

- **One HLAO instance is one address space.** An instance is `HLAO_HOME` plus its supervisor,
  socket, and token. Every session in it is addressable by every caller by id, unique name, or
  unique prefix.
- **Isolation is another instance.** Want a separate swarm or trust domain? Use a different
  `HLAO_HOME`, socket, and token. No core mechanism connects instances.
- **`callerSessionId` is attribution, not permission.** It records `by` on mutating events and
  supplies self-defaulting. A stale id does not authorize or forbid anything.
- **Lineage is context.** `parentId`, `rootId`, and `depth` describe who spawned what and are
  injected into the child. They do not grant visibility or control. The parent-send exception
  in ADR 0006 disappears because general addressing subsumes it.
- **Everything inside is semantic.** Swarm membership, roles, shared agreements, and naming
  conventions live in user space: context passed at spawn and files readable by the
  participants. They are not HLAO objects.
- **Enforcement of invented concepts is a plugin concern.** If a swarm later wants enforced
  namespaces or roles, it is a client/plugin layer, not core. Core stays permissive.
- Operator-only methods (`reload`, `shutdown`) remain: they operate on the instance, not on a
  session.

## Alternatives rejected

- **Keep self-and-descendants.** It invents a boundary a harness does not have, makes the
  parent link an authority, and prevents cooperating sessions from addressing each other
  without a shared registry.
- **Enforce a swarm object in core.** A swarm object would be a second authority over which
  sessions exist and who may touch them — the store/kanban failure in another form.
- **Global addressing across instances.** That conflates trust domains. Instances are the
  isolation mechanism; the token is the boundary.
- **Per-session ACLs in core.** A new concept with no harness counterpart; it belongs in a
  plugin, not the primitive surface.

## Consequences

- Any caller in an instance can read, message, cancel, close, or permit any session. This is
  the same power a human with the harness has. Attribution events make the actor visible;
  conventions and separate instances are the mitigations.
- Names and prefixes are instance-wide. Duplicate names are `ambiguous_id`; the full handle
  always resolves.
- A stale `HLAO_SESSION_ID` can still act; the action is attributed to that id. It cannot use
  `--self` against a session that is not live.
- `sessions.list` is a flat view of the instance. The protocol version becomes 2.0 because
  `scope` disappears and previously forbidden targets are now allowed.
- The four acceptance assemblies still hold; delegation becomes a convention rather than an
  enforced tree.
