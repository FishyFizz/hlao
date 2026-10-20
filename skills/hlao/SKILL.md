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
hlao send <id> "..."            # prompt another session
hlao wait --until permission --timeout 10m
hlao queue                      # what is queued behind the active turn
hlao permit <id> --allow        # answer a pending permission request
hlao elicit <id> --accept k=v   # answer a provider question (--decline/--cancel)
hlao get <id>                   # state only, no events
hlao list --mine                # the sessions in your job's root subtree
hlao spawn <backend> --resume <provider-id> --cwd <dir>   # pull an interrupted agent back up
hlao spawn <backend> --fork <provider-id> --cwd <dir>     # copy one; the source is untouched
```

Spawning reports a provider session id (`provider …` in human output, `agentSessionId` in
JSON). Keep it in your context. Your HLAO id is an alias for the supervisor's lifetime; the
provider id survives a restart. `spawn --resume <provider-id> --cwd <original cwd>` reopens
that provider session and replays its history; the interrupted turn is not replayed, so
re-send the instruction. `spawn --fork <provider-id> --cwd <original cwd>` copies the session
instead; the source keeps running and can still be resumed separately.

A session runs one turn at a time. Messages queue visibly and run in order. `--wait` waits for
that message's turn; a timeout leaves the work running.

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

A reply is an inbound prompt: it queues until the recipient's turn ends. Do not wait inside
your turn for a reply that will arrive as a prompt. Send the reply without `--wait`; it runs
after the recipient's current turn. HLAO rejects a send or wait that would close a wait cycle
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

- A pending request is visible in `read` and in `list --pending`. The operator, or another
  session (normally the parent), answers it with `hlao permit <id> --allow`, `--deny`, or
  `--option <id>`. A provider question is separate and never auto-answered: `hlao elicit <id>`
  shows it, and `--accept key=value`, `--decline`, or `--cancel` answers it. A session parked
  on either gate cannot run a command to answer itself; leave a clear blocker and let the
  operator or parent answer.
- The operator owns the permission gate. Do not change your own or another session's policy to
  remove it; report the blocker instead.
- The instance token is the real authority. `ask` makes a request visible; it is not
  containment. Cooperate with the gate rather than working around it.

If a command is unclear, run `hlao help <command>`; the CLI is the source of truth.
