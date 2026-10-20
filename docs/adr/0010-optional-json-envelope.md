# ADR 0010 — The JSON success envelope is opt-in

**Status:** accepted, 2026-10-20 (milestone 0.7).

## Context

`--json` is the agent-facing contract, but it is not one shape. `spawn` returns
`{session, nextSeq, firstTurn?}`, `send` returns a different object, `mode` returns raw modes on
read and `{session}` on write, `agents` uses `{agents}` while the wire uses `{backends}`, and
`status`/`doctor` have their own health objects. Errors use `{ok:false,error}` on stdout.
An agent that wants one parser must special-case every command.

The wire is versioned and the CLI's JSON is documented, so this is design debt rather than a
bug. It has a closing window: changing the default shapes after 1.0 is expensive.

## Decision

- Add an opt-in `--json=envelope` (also accepted as `--json --json-envelope`).
- A successful command prints `{ ok: true, command, result }`; a failure prints
  `{ ok: false, command, error }`. `command` is the top-level command name (`config show`
  reports `config`).
- The default `--json` shapes are unchanged. Existing scripts keep working.
- Streaming JSON (list `--watch`, read `--follow`, logs `--follow`) wraps each line in the
  same envelope. `--jsonl` event streams are excluded: `--json=envelope` with `--jsonl` is a
  usage error, because an event line is not a command result.
- The wrapper lives in one place (`writeJson`/`writeJsonLine`/`writeJsonFailure`), so a new
  command cannot forget it. A conformance test exercises every command.

## Consequences

- One parser can consume any command's success or failure without knowing its shape.
- The default surface stays compatible through 0.7.x. At 1.0 the default can be switched to
  the envelope, or the opt-in can remain and be documented as the stable mode.
- Health commands (`status`, `doctor`) stay inside the same envelope in this mode, fixing
  their current exception.
- `agents`/`backends.list` key drift is not changed here; the envelope makes the command's
  payload explicit without breaking existing consumers.

## Alternatives rejected

- **Change the default now.** It would break every script and agent written against 0.5-0.7
  for a naming preference. An opt-in proves the shape first.
- **A per-command JSON Schema only.** Useful for editors, but it does not give a consumer one
  entry point; the envelope does.
- **Wrap only some commands.** Partial coverage recreates the special-casing the envelope is
  meant to remove.
