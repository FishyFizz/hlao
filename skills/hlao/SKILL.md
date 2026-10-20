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
hlao send --self "..." --wait   # prompt yourself (the first positional is the message)
hlao send <id> "..."            # prompt another session
hlao wait --until permission --timeout 10m
hlao queue                      # what is queued behind the active turn
hlao permit <id> --allow        # answer a pending permission request
hlao get <id>                   # state only, no events
hlao list --mine                # the sessions in your job's root subtree
```

A session runs one turn at a time. Messages queue visibly and run in order. `--wait` waits for
that message's turn; a timeout leaves the work running.

## Worker loop

```bash
hlao send --self "Check the log again." --wait --timeout 20m
hlao read --since 42
hlao wait --until permission --timeout 10m
hlao send "$HLAO_PARENT_ID" "Blocked: the lock file is held by another worker."
```

`wait` is one-shot: it resolves once and must be re-armed. `idle` means no active turn and no
queued prompt; `permission` means the provider is waiting for an answer; `exit` means the
session ended.

## Reporting

- Finish with what the operator asked for. If the prompt names a result format, use it.
- If you are blocked, send a concise fact to `$HLAO_PARENT_ID`: what you tried, what is
  missing, and what would unblock you. Do not guess.
- If a command fails, read the error and stop; do not loop on a dead adapter.
- Do not spawn a replacement session unless the operator asked.

## Permission and trust

- A pending request is visible in `read` and in `list --pending`. Answer it with
  `hlao permit <id> --allow`, `--deny`, or `--option <id>`.
- The operator owns the permission gate. Do not change your own or another session's policy to
  remove it; report the blocker instead.
- The instance token is the real authority. `ask` makes a request visible; it is not
  containment. Cooperate with the gate rather than working around it.

If a command is unclear, run `hlao help <command>`; the CLI is the source of truth.
