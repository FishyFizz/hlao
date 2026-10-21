---
name: hlao
description: Use when you are a session inside an HLAO instance. How to report, wait, delegate, and hand work back without inventing context. Context arrives in the prompt, verbatim or by reference; HLAO does not carry file payloads.
---

# HLAO session skill

You are a session inside an HLAO instance. The human operator and every session drive the
same `hlao` CLI. Your task is in your prompt; this skill tells you how to act inside the
harness.

## Identity

- `HLAO_SESSION_ID` — your handle.
- `HLAO_PARENT_ID` — who spawned you (absent at a root).
- `HLAO_ROOT_ID` — the job root.
- `HLAO_DEPTH` — 0 at the root.
- `HLAO_BACKEND` — the backend running you.
- `HLAO_SKILL` / `HLAO_SKILL_VERSION` — this file and its package version.
- `HLAO_CLI` — absolute CLI path when `hlao` is not on `PATH`.

Lineage is context, not authority. Every session in the instance is addressable by id, unique
name, or unique prefix. You may read, wait on, message, or close any session in the instance;
that is a coordination rule, not permission to interfere with unrelated work.

## The prompt is the contract

- Everything you need is in your prompt, **verbatim or by a named reference**.
- If a ledger, spec, log, image, or file is named, read it with your own tools.
- If it is not named, ask. Do not infer paths, facts, or state.
- When you hand work to another session, pass context the same way: verbatim or by reference.
  Do not assume the child can see your context, and do not invent a shared-state mechanism.
- HLAO carries orchestration text, not payloads. It does not attach files or images. Reference
  a path; use your own file tools and vision.

## Moves

```bash
hlao read                       # your state plus a page of events
hlao read --since 42            # continue from a cursor
hlao send --self "..."          # queue your next turn (do not wait inside this one)
hlao send <id> "..."            # prompt another session; steers if it is mid-turn
hlao wait --until permission --timeout 10m
hlao queue                      # what is queued behind the active turn
hlao permit <id> --allow        # operator only; an agent reports the blocker
hlao elicit <id> --accept k=v   # answer a provider question (--decline/--cancel)
hlao get <id>                   # state only, no events
hlao find "text"                # search other sessions' events
hlao usage                      # fleet cost and context snapshots
hlao list --mine                # the sessions in your job's root subtree
hlao provider sessions <backend> --cwd <dir>              # the provider's own catalog
hlao children --self                                     # provider ids this session attached
hlao children --provider <id>                            # the same receipts, read offline
hlao adopt <backend> <provider-id> [--cwd <dir>]          # take one in as a new agent
hlao spawn <backend> --resume <provider-id> --cwd <dir>   # pull an interrupted agent back up
hlao spawn <backend> --fork <provider-id> --cwd <dir>     # copy one; the source is untouched
```

Spawning reports a provider session id (`provider …` in human output, `agentSessionId` in
JSON). Keep it in your context. Your HLAO id is an alias for the supervisor's lifetime; the
provider id survives a restart. `spawn --resume <provider-id> --cwd <original cwd>` reopens
that provider session and replays its history; the interrupted turn is not replayed, so
re-send the instruction. `spawn --fork <provider-id> --cwd <original cwd>` copies the session
instead; the source keeps running and can still be resumed separately.

When you spawn or adopt a child, HLAO writes a historical spawn receipt pairing your provider
id with the child's provider id (plus backend, cwd, and name) in `$HLAO_HOME/spawn-ledger.jsonl`.
After a restart, `hlao children --self` reads it; `hlao get --self` reports your own provider
id, and `hlao children --provider <id>` reads the same ledger without a supervisor. Resume a
child by provider id, not by title. Because an agent caller is the default parent, the new
HLAO attachment lands under you:

```bash
hlao children --self
hlao get --self                                  # your own provider id, if needed
hlao adopt <backend> <child-provider-id>
```

If you were forked rather than resumed, your provider id is new: read the source's
receipts with `hlao children --provider <source-provider-id>`. The ledger is per HLAO home;
a different home has no receipts.

Receipts are history, not liveness: a child may have ended, and adoption returns a live
duplicate when one still holds the same provider id. Use `--fork` when the source may be
open in another client or HLAO home; HLAO cannot detect that other driver, so a resume is a
takeover and a fork leaves the source alone.

If a receipt is missing, search your own replayed history for the exact id before guessing:
`hlao read --self --grep "provider " --raw --context 2`, or `hlao export <self>` and search
the export. Only then fall back to `hlao provider sessions <backend> --all`. A catalog row's
title, cwd, and age are discovery hints, not identity: adopt a candidate, read its replayed
history, and verify the job before sending work. A provider-only row adopted with
`hlao adopt <backend> <provider-id>` gets a new HLAO id, name, and lineage, and keeps the
provider's history and mode.

A session runs one turn at a time. A message to an idle session starts a turn directly. A
message from one session to another that is mid-turn is **steered** into that running turn
when the target's adapter supports it; otherwise it queues visibly and runs in order. An
operator shell queues by default; `--steer` and `--queue` override either side. A self-send
always queues. `--wait` waits for the turn that will carry the message (for a steered message,
the running turn); a timeout leaves the work running.

## Worker loop

A session is either inside a turn (you are running now) or between turns.

Inside a turn:

- Use `hlao read` / `hlao read --since N` to inspect your transcript.
- Use `hlao wait <other-id> --until settled` only to wait on *another* session.
- Report a blocker in your final message; do not send yourself a message and wait.

Between turns:

- A self-send is a deferred next turn: `hlao send --self "Check the log again."` without
  `--wait`. Finish the current turn; the queued prompt runs next.
- Report a blocker to the parent: `hlao send "$HLAO_PARENT_ID" "Blocked: ..."`.

Do not use `hlao send --self "..." --wait` from inside a turn. The message queues behind the
turn you are in, so the wait cannot finish. HLAO rejects that shape with `bad_request` and
names the deferred form.

A reply is an inbound prompt: if the recipient is mid-turn, it is injected into that turn
(steering); if the recipient is idle, it starts its next turn. Either way, do not wait inside
your turn for a reply that will arrive as a prompt. Send the reply without `--wait`; steering
can inject it into the recipient's running turn, but it cannot settle a turn that is itself
blocked waiting on you. HLAO rejects a send or wait that would close a wait cycle
(`wait cycle: A -> B -> A`) instead of letting both sessions block until an operator
interrupts. A state wait on your own turn (`hlao wait --self --until settled`) is rejected for
the same reason; `hlao wait --self --until change` remains valid because a queued prompt emits
its event during the current turn. Do not filter that change wait to `prompt.sent`,
`turn.started`, or `turn.ended`: those events only exist after the turn ends, so the wait
would deadlock.

`wait` is one-shot: it resolves once and must be re-armed. `idle` and `settled` mean no
runnable turn: finished, parked at a permission gate, or ended. `permission` means the
provider is waiting for an answer; `exit` means the session ended.

## Reporting

- Finish with what the operator asked for. If the prompt names a result format, use it.
- If you are blocked, send a concise fact to `$HLAO_PARENT_ID`: what you tried, what is
  missing, and what would unblock you. Do not guess.
- If a command fails, read the error and stop; do not loop on a dead adapter.
- Do not spawn a replacement session unless the operator asked. Resuming a session you
  spawned with `--resume` continues it; it is not a replacement.

## Permission and trust

- The provider's mode is the permission policy. There is no HLAO `allow|ask|deny` setting and
  no auto-answer: every provider ask is relayed to the operator.
- A pending request is visible in `read` and in `list --pending` as
  `pendingPermissions` (a FIFO queue; parallel asks are each answerable). **Answering is
  operator-only.** `hlao permit` and `hlao mode <id> <mode>` from a shell with
  `HLAO_SESSION_ID` are refused with `operator_only`. Do not try to answer your own or a
  child's request, and do not change a mode: report the blocker to `$HLAO_PARENT_ID` or the
  operator and stop.
- A provider question is separate and also never auto-answered: `hlao elicit <id>` shows it,
  and `--accept key=value`, `--decline`, or `--cancel` answers it. A session parked on either
  gate cannot run a command to answer itself; leave a clear blocker.
- The operator may have set a per-backend `defaultMode`; an agent-spawned child inherits it.
  An agent cannot pass `--mode`.
- This control is advisory, not an ACL. The instance token is the real authority. Cooperate
  with the gate rather than working around it; containment needs a separate instance.

If a command is unclear, run `hlao help <command>`; the CLI is the source of truth.
