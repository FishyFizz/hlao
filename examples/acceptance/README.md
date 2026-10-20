# Acceptance assemblies

`PRODUCT.md` says the job is done when four known orchestration shapes can be rebuilt in user
space out of the primitives, with the assembly explained in human terms. These scripts are
that test. They use only the public CLI.

Set `HLAO_CLI` to the built entry point if HLAO is not installed globally:

```bash
export HLAO_CLI="$PWD/dist/cli.js"   # PowerShell: $env:HLAO_CLI="$PWD\dist\cli.js"
```

The examples accept `--env K=V` to pass environment to the spawned session; the automated
tests use that to drive the scripted ACP agent in `tests/fixtures/`.

## Running them safely

A direct run uses a fresh temporary `HLAO_HOME`, so demo sessions never mix into real work.
Pass `--home DIR` or set `HLAO_HOME` to reuse an instance. `HLAO_EXAMPLE_TIMEOUT_MS` overrides
the per-command bound (default 120s). Every script closes what it spawned in a `finally`; if
it fails, the supervisor may still hold a session, so `hlao list` and `hlao down` remain the
recovery path.

Results use what the turn actually returned. `spawn --wait` carries the turn text, so a
worker whose transcript exceeds one read page is not truncated; scripts fall back to
`hlao export` (full history) when the turn result is unavailable.

## 1. cron — recurring timed work

```bash
node examples/acceptance/cron.mjs --backend claude --interval 30s --max-checks 100
```

**Human terms.** A person checks a build log every minute until it says the build finished.
They know when to stop because they can read the log.

**Assembly.** Recurrence is the loop. The timer is the script's own sleep between checks —
not `wait --until change`, which any agent chunk or usage update can satisfy. The judgement is
the monitor session's reply. Termination is `STATUS: DONE`, read by the loop. Stopping is
`hlao close` in a `finally`.

**Why no new primitive.** A recurring timer would make the supervisor the authority on a
world condition it cannot read. Here the loop reads the world through an agent and chooses
when to check again. If the loop dies, monitoring stops, which is the right failure.

## 2. kanban — shared work state across sessions

```bash
node examples/acceptance/kanban.mjs --backend claude --ledger board.md --tasks "a,b,c"
```

**Human terms.** A board on the wall. Cards are work items; columns are where a card is; the
shared state is the board, at a path anyone can read.

**Assembly.** A card is the prompt that spawns a worker. A column is the session's
orchestration state (`idle`, `busy`, `closed`). The board is a file. Moving a card is
`hlao send`. The WIP limit is how many workers the orchestrator chooses to spawn. Done means
appending the result and closing the worker.

**Why no new primitive.** The ledger path is passed by reference to every worker, so a worker
spawned later reads the same board. The failure to watch is the one `PRODUCT.md` names: a
trusted-and-stale file. No object makes that risk disappear; an announcement convention keeps
it visible.

## 3. subagent delegation

```bash
node examples/acceptance/delegation.mjs --backend claude --task "summarize the README"
```

**Human terms.** Hand a bounded task to a colleague, remember which pane they are in, wait,
read the result, integrate it.

**Assembly.** `hlao spawn --wait` (the handle and the turn result), the spawn prompt (the
joining facts), `hlao export` as the fallback for the full transcript, `hlao close` in a
`finally`.

**Why no new primitive.** The child is a session the parent holds a handle to. The parent's
knowledge of its children is naming, the same way a person remembers panes. No subagent
object is needed.

## 4. dynamic workflow

```bash
node examples/acceptance/workflow.mjs --backend claude --goal "migrate the build to the new runner"
```

**Human terms.** Ask someone to check whether a task is possible, then decide what to do with
the answer. If they say it cannot be done, the job stops and the finding reaches you. Their
finding changes the plan; the plan was not fixed before they looked.

**Assembly.** Spawn a scout; read its verdict; branch in the orchestrator; spawn the worker
only if allowed; close both.

**Why no new primitive.** The decision point is a normal `if` in a running orchestrator. The
contrast with a frozen workflow is the point: the finding has a path back up because the
orchestrator is still running and still free. A frozen plan has no such path.

## Running them against the test agent

The e2e suite runs all four with the scripted backend, including the counter and verdict
modes. See `tests/e2e/acceptance.test.ts`. That is the repeatable proof; running these
against a real provider additionally proves the leaf, which HLAO does not claim to control.
