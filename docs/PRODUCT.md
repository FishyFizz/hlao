# PRODUCT

**Goal**

> Nothing about an agent-run job is decided before the job is understood. The agent driving
> the harness, through the same plain primitives a person uses, decides the next move at the
> moment it can see the situation.

**For whom.** Someone driving agents on long-running real work, who loses jobs to
orchestration they can't see into. This starts as a tool for one operator — the author — and
that is a legitimate scope, not a shortfall. Whether it is for anyone else is open; see Open
questions.

**Scope: structure, not judgement.** The design governs *who decides what, when, and with how
much freedom*. It does not govern whether an agent reads the world correctly. Agents are
imperfect, and that failure class cannot be erased by any orchestration design. This design
claims exactly the failures that contain **no judgement error**.

That is not a retreat, it is the load-bearing distinction — and the cron episode proves it.
Every fired session reported "done," and correctly. It failed anyway. Structural failure is
therefore a thing in its own right, separable from judgement, and separable is what makes it
fixable.

---

## The problem

Harness orchestration primitives **freeze decisions at authoring time** — by the harness
author, for everyone, before the work exists — and nothing during execution can revise them.
The agent that can see the situation is not the agent with the authority to act on it.

Three episodes, one failure:

**Hermes cron for build monitoring.** "Create a cron job to monitor this build log." The
build finished; the cron kept firing; every fired session reported "it's done." Two frozen
decisions: cron-spawned sessions don't receive the cron management tools, so the observer
could not cancel; and the primitive has no *stop when* clause at all, so the job's real
termination condition — "the log says done" — was never expressible.

Neither the user nor the first agent held a wrong model of cron. Both held a correct model
of *recurring timed tasks*, which is not the job they had. The failure was invisible at
authoring time and unbounded afterwards: a leak, not a break, pinging the user repeatedly
with something they already knew.

**Hermes kanban.** Too complex to model without using it; unusable without modelling it. The
tool never ran a real job, so it never failed — it never started. The ontology is fixed and
the job must conform; a job that doesn't map cannot be expressed.

**Claude Code dynamic workflow.** The script is legible — you can read the plan — but it is
frozen before execution. When an agent mid-task finds "this task can't be done," control
flows down and findings have no path back up. An agent-generated workflow script is the same
shape one level removed: a planner without in-flight knowledge fixes the plan in advance,
then execution cannot deviate.

|                    | primitive legible?                        | agent free at runtime? |
| ------------------ | ----------------------------------------- | ---------------------- |
| Hermes cron        | no — hidden tool surface, no stop-when    | no                     |
| Hermes kanban      | no — model not inferable without use      | no                     |
| CC dynamic workflow| yes                                       | no                     |

All three are frozen. Legibility is necessary — without it the agent cannot even notice it
is trapped — but **freedom is the point.** Workflow proves that legibility alone buys
nothing.

**The rule beneath it:** *ambiguity is the mechanism of frozenness.* A primitive with hidden
semantics can only be used the author's way, so its freedom is illusory. A primitive with
plain semantics can be composed freely.

**What the three episodes share.** In every one, the participant carried an **invisible
boundary to its own knowledge**. The cron agent did not know its own job's nature, nor that it
could manage it. The workflow executor did not know it was permitted to object. The kanban user
could not see the model well enough to know what he had failed to understand. "Black box" and
"blind spot" both mean this: not hidden machinery, but a boundary the participant cannot see.
A visible boundary is actionable — read the ledger, ask the parent, investigate. An invisible
one leaves no move at all.

---

## The shape

Not a framework. A **primitive surface** — likely six to eight operations — plus one
correspondence rule:

> If a person can't do it by hand, the agent shouldn't be able to either. If the agent can do
> something a hand can't, that thing is a harness concept in disguise and the blind spot is
> back.

The primitive set is not invented; it is **observed** — whatever a human operator does with
the harness, and nothing more. Roughly: open a session, send it a message, read its output
and state, wait, act on what it found.

Two primitives carry all the risk:

- **`wait` must be one-shot.** "Wait 20 minutes" means wake once. The moment a recurring
  timer ships, cron is back and the thesis is undone. Monitoring is `wait → read → judge →
  wait`, with the judgement deciding whether to re-issue.
- **Read/observe speaks only about orchestration state — never about the world.** Its domain
  is the design's own objects: which sessions exist, whether each is alive or idle, what it
  last emitted, which jobs are pending, whether this session is itself a spawned one. "Is the
  build done?" is never its question. That belongs to the leaf.

Both rules are one property seen twice, and it is why unambiguity here is *achievable* rather
than merely desirable: **the design's primitives are self-referential.** They describe only
objects the design itself created, so the design is the final authority on what they mean.
This also names cron's failure exactly — a world-monitoring task forced into a
self-referential primitive (`run this prompt on a schedule`), where the world's termination
condition had nowhere to go, because the primitive was never about the world.

**Where state lives.** Orchestration state must be readable by the operator: sessions and
the filesystem. If a store appears, it is a kanban again. (Settled in Q2 and `STACK.md`: the
live provider sessions are the state; identity is injected at spawn and held as handles. No
separate store.)

---

## The leaf — delegated, and out of scope

The leaf is where an agent actually touches reality: read a file, run a shell command, check
a result code, judge whether a log says success. In the build-monitoring episode the leaf was
the read and shell tools handed to the agent by the harness underneath — Claude Code, or
whatever provider is being driven.

The design does not build leaves and does not try to. Judgement lives there, agents are
imperfect, and **that class of failure survives every possible orchestration design.** Trying
to fix it would be trying to make agents perfect, which is not a design problem.

Two consequences:

- **Assumption:** the provider's leaf tools are trustworthy. If a leaf tool lies — truncates
  silently, returns stale content, times out without saying so — the agent misjudges, and no
  structure above it can prevent that. This is a provider dependency, stated rather than
  assumed away.
- **Obligation:** the design cannot reduce the *rate* of judgement errors, but it can
  guarantee that a judgement error is **reportable, recoverable, and not self-perpetuating.**
  Cron's structure made one correct judgement permanent and un-voiceable. Any structure that
  leaves an agent no way to say "I am not sure" converts a judgement failure into a structural
  one — and that part is squarely in scope.

---

## Shared work — convention, not object

Shared state is the case that most invites a store, so it gets an explicit answer.

A person driving several agents shares results by naming: they know which session is which,
they copy a result from one to another, and if a file is shared and they don't want to copy
it, they tell every session "the file is at path P". Nothing there is an object. It is naming
plus messaging, applied consistently.

The orchestrating agent does exactly the same, out of the same primitives:

- holds handles to the sessions it spawned — **naming**
- reads from one and sends to another — **transfer**
- announces a shared fact to each participant by message — **convention by announcement**

There is no shared-state object, and therefore nowhere for a store to hide.

The failure this introduces is a *convention failure*, not a black box: a participant spawned
**after** the announcement does not know the fact. The answer is the human's answer — the
spawner carries the fact into the spawn — and it holds because the spawner is the one who
chose to spawn, so it is present and informed at the moment that matters. Note this is the
cron diagnosis again, one level down: a decision made by someone who lacked the information.

### What an announcement is

**A fact is an announcement when it is true of the *job* rather than of any participant in
it.** The test is forward-looking: *if a session spawned tomorrow would need this fact to act
correctly, it is an announcement.* "The build is at rev 123" qualifies. "I prefer tabs" does
not.

This yields the structural property directly. An announcement is an obligation owed to every
participant including the unborn, discharged by an act — sending messages — whose recipient
list is fixed at one instant. **An unbounded debt paid by a bounded act.** The late-joiner gap
is not a delivery flaw; it is inherent in that mismatch, and cannot be closed by sending more
faithfully — only by changing what is sent.

That splits announcements into two roles with different answers:

- **The joining fact set.** Everything true at the moment a participant enters. No gap: if the
  spawner carries it, every participant is complete *by construction*, because there are no
  late joiners — only births that arrive fully informed. The spawn *is* the delivery.
- **The change notification.** A fact that becomes true after participants already exist.
  Needs an accurate answer to "who is everyone *in my subtree*," plus a durable place for facts
  that don't vary per recipient.

**Rule: announce by reference, not by copy.** A copy's audience is fixed when it is sent. A
reference — a path, a document — can be read by anyone at any time, including the unborn, so a
pointer announced once stays true and the spawner only ever forwards the pointer. The
copy case is the one that silently rots. *(Open: whether reference is the default or the
fallback for when copying is costly — see Open question 7.)*

Two consequences:

- **This tightens open question 6 rather than sitting beside it.** A change notification
  requires the announcer to know the participant set *at the moment of change*. Under universal
  addressing, the announcer can name any session, but its *knowledge* is still bounded by the
  handles it spawned and the agreements it has read: an announcer is correct for the set it
  knows. A job-wide change must therefore come from a common ancestor — ultimately the root —
  whose known set contains every affected participant. The gap stays visible: the agent knows
  whom it can name and that its picture may be incomplete outside the set it knows.
- **An announcement is an assembly, never a primitive.** It is `list sessions` filtered to the
  announcer's known handles (or a user-space membership file), plus `send` × n. "Announcement"
  is exactly the kind of concept that would otherwise arrive as a new object, and objects are
  where black boxes live.

### Why announce at all: waste avoidance

The *why* matters more than the *what* here, and it is better stated by purpose than by scope.
An announcement exists to **prevent wasted investigation** — to stop another participant
spending effort on something already settled. That formulation carries a cost model the
scope-based one cannot: announce when the work the announcement prevents exceeds the
interruption it costs. It is the only form of the definition that can tell you when to stay
quiet.

### The shared ledger

Pre-announcement and post-announcement are not two concepts. They are the **read path** and
the **write path** of one thing: a shared ledger. A standing document that every participant
entering the scope reads, plus messages that keep it true.

It is the same shape as `CLAUDE.md`, with one correction. The strength of `CLAUDE.md` is *not*
the contract framing — a contract is something a participant is obliged to remember. Its
strength is that it is **injected**: the harness puts it in front of the agent, so reading is
neither optional nor forgettable. So **"must read" is a property of birth, not a duty on the
joiner.** The spawner injects the ledger and nobody has to remember anything. This is the cron
fix again — make the correct thing the default rather than an obligation.

Two consequences:

- **The ledger is passed by reference, never copied into the spawn prompt.** If a spawner
  summarises it, a grandchild inherits the parent's paraphrase of the contract, and it drifts
  a generation at a time. One file, one path, forwarded. This is the second time the filesystem
  has turned out to be the answer.
- **The failure to watch is a trusted-and-stale ledger.** A `CLAUDE.md` that is out of date is
  worse than none, because participants act on it with confidence. Pre-announcement's entire
  risk profile is rot; post-announcement is the maintenance path.

Note that the ledger is a *convention*, not a design object — its content is world-reference,
which is the leaf's business. The design stays self-referential; the ledger lives in user
space on the filesystem.

---

## Delegation and the information gap

Delegation is as efficient, and as inefficient, as human organization. Efficient because work
runs in parallel. Costly because every hand-off opens an information gap — spatially (a
different session, a different context) and temporally (facts that became true after the
recipient was born). Q8 surfaced this: the ledger-write question is really a question about how
much shared understanding an organization can sustain.

**The gap is not a flaw in delegation. It is delegation.** If the gap were zero, the spawner
would have to transfer its entire context, which is the same as doing the work itself. The gap
is the interface, and the interface is what makes handing off tractable. So "minimize the gap"
cannot be the design target — that would be designing delegation away.

The target is **make the gap visible.** A participant that knows who spawned it, what it was
given, that its parent's picture is itself partial, and where the ledger is, holds *bounded and
nameable* ignorance — and bounded ignorance is actionable: read the ledger, ask the parent,
spawn an investigator. Unbounded and invisible ignorance leaves it with no move at all. This is
the same requirement as the rest of the design, applied to knowledge rather than to control.

**Scope, stated deliberately:**

- **Shallow delegation — supported.** Parent spawns child, child does a bounded task, returns,
  parent integrates. The *shape* is the same as subagent delegation today; what differs is what
  happens inside that shape, where today's version is frozen exactly as everything else is.
- **Deep delegation and autonomous networks — out of scope, and unbuilt-for.** Not because the
  problem is unstated, but because it is not solvable: it is the problem human organizations
  have, and human organizations do not solve it by communicating better. They solve it with
  structure — bounded spans, limited authority, standing interfaces, escalation paths. That is
  organization and judgement, not primitive design, and it is out of scope for the same reason
  a misread build log is.

  The actionable half: **every mechanism aimed at the deep case must be absent.** A global
  registry, a coordination protocol, a consensus mechanism — each exists to serve the case just
  excluded, and each is a kanban. The exclusion is not a shrug; it is a build constraint.

---

## Acceptance test

Rebuild each of these in user space, out of the primitives, and explain the assembly in
human terms:

1. cron — recurring timed work
2. kanban — shared work state across sessions
3. subagent delegation
4. dynamic workflow

All four pass → the primitives are sufficient and the job is done. If any one needs a new
primitive, the thesis failed at that point, and we will know exactly where.

---

## What this is not

- Not a scheduler, DAG engine, or state store. Any such thing is the black box returning.
- Not deterministic. See the trade below.
- Not a judgement-improvement layer. It does not make agents read the world more accurately;
  it makes their reading reportable and correctable. See *The leaf*.
- Not an attempt to do cron, kanban, or workflow *better*. They are assemblies, not features
  to be reimplemented.

---

## The trade, made knowingly

Frozen orchestration buys reproducibility and protection: a fixed workflow cannot do
something wild, and one panicking agent cannot abort eight others. Unfreezing buys
adaptivity and costs protection from your own agents — the same freedom that lets an agent
stop a doomed job lets it derail a good one. For a single operator on their own work this is
the right trade. It is a choice, not a free win.

---

## Workarounds today

*Not directly established. This is read off the episodes rather than stated by the author —
confirm or correct.*

- **Kanban:** abandoned entirely. Categorical cost: the tool delivers nothing.
- **Cron:** used, then lived with. The leak runs until manually cleaned up.
- **Workflow:** used, hits the wall when a task proves impossible, then worked around by hand.

---

## Routes already rejected

- **Better documentation of cron.** Rejected: the author held the *correct* model of cron and
  still chose it. The docs were not wrong; the primitive was.
- **Exposing cron management tools to cron-spawned sessions.** Fixes this instance, not the
  class. The primitive still cannot express "stop when," and the next monitoring job fails
  the same way. The self-scheduling model subsumes it: termination becomes the default rather
  than an action someone must remember to take.
- **Agent-generated workflow scripts.** A weaker version of the same idea — planned once, in
  advance, by an agent with less information than the executor.
- **Re-planning with full freedom and no ratchet.** Rejected: re-plan → "can't be done" →
  re-plan thrashes and cannot be audited. Freedom needs a bound.

---

## Open questions

1. **Shape of read/observe.** The one piece that can still sink this. What exactly does it
   report, and how does it separate knowable state from judgement?
   *Substrate fixed (`STACK.md`):* ACP's typed `session/update` stream supports cursor-addressed,
   bounded reads, with orchestration state projected separately from leaf output.
   *Resolved by:* designing the projection against the cron episode and checking it would have
   made that failure impossible.

2. **Where orchestration state lives.** Must be operator-readable.
   **Settled (`STACK.md`).** The live provider sessions are the state; ACP can list, load, and
   resume them. A participant's identity is injected into its environment at spawn, and a
   parent's knowledge of its descendants is the handles it holds. There is no separate store;
   user-space facts (ledger, contact list) are files by convention.

3. **Frequency and cost.** Asked twice, answered with instances rather than numbers. Kanban
   abandonment is the only hard figure and it is categorical, not measured.
   *Resolved by:* a count of how often this bites, and what it costs in hours.

4. **The ratchet.** If agents may re-plan freely, what bounds thrash, and who may halt a job
   in flight?
   *Primitive available (`STACK.md`):* `session/cancel` for a graceful halt, process kill for a
   hard one. The policy — who may issue them and what bounds thrash — is still open.
   *Resolved by:* the halting rule, stated before the freedom is granted.

5. **Whether this is for anyone but the author.** A personal toolkit is a legitimate end
   state.
   *Resolved by:* whether anyone else reaches for it unprompted.

6. **Is session enumeration global or scoped?** **Resolved (2026-10-20): universal within an
   instance; the instance is the swarm boundary.**

   One HLAO instance — one `HLAO_HOME`, supervisor, socket, and token — is one address space.
   Every session in it is addressable by every caller. `callerSessionId` is attribution and
   self-defaulting, not a visibility filter. `parentId`/`rootId`/`depth` are lineage and
   context, not authority.

   Isolation is another instance: a separate home, socket, and token. There is no cross-instance
   visibility or addressing. Inside an instance, swarm membership, roles, and agreements are
   user-space conventions — context passed at spawn and files readable by the participants.
   Nothing in core enforces them.

   The earlier self-and-descendants rule was rejected: it invents a boundary a harness does not
   have, and it turns the spawn ledger into an authority over who may see and stop what. A
   person with the harness can address any session it can name; an agent should use the same
   moves. The trade is stated openly: any caller in an instance can interfere with any session.
   Attribution makes the actor visible; conventions and separate instances are the mitigations.
   Enforced namespaces or roles, if ever wanted, belong in a plugin, not the primitive surface.

   Consequence for announcements: an announcer is still *correct* for the participants it
   knows it spawned. A job-wide change should still come from a common ancestor — not because
   addressing forbids otherwise, but because only that ancestor knows the complete participant
   set. Siblings and cousins are reached by the agents' own contact-list convention.

7. **Is announcing by reference the default, or a fallback?** A copy-broadcast is the lazy
   path and the one that rots as the participant set changes; a reference is durable and
   survives the unborn. Arguing for reference-as-default assumes an agent can reliably tell
   when a fact will outlive its recipients — which is itself a judgement call, and judgement
   is the leaf.
   *Resolved by:* deciding whether that judgement is cheap enough to make the durable form the
   default, or whether the design should simply always announce by reference and remove the
   judgement entirely.

8. **Who holds write authority over the ledger?** This decides whether the contract is
   trustworthy or merely present. Orchestrator-only means the ledger is exactly as complete as
   the orchestrator's picture — which is open question 6. Any-participant-means it is no longer
   something others can rely on. And a participant who discovers a claim is false must not be
   in the cron position: informed, and unable to act.
   *Resolved by:* choosing between orchestrator-only, discoverer-writes-and-must-announce, or
   append-only with corrections as new entries — the last of which keeps the ledger from
   silently changing under a reader who has already read it, and makes the correction itself an
   announcement.
