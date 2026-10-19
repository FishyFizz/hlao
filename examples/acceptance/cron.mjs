#!/usr/bin/env node
/**
 * Acceptance assembly 1 — cron: recurring timed work.
 *
 * Human terms: a person checks a build log every minute until it says the build
 * finished. They know the termination condition because they can read the log.
 *
 * Assembly:
 *   recurrence  = this loop
 *   timer       = `hlao wait --timeout <interval>` (a one-shot await that
 *                 expires; the timeout is the timer, not a schedule)
 *   judgement   = the monitor session's reply, read by this loop
 *   termination = `STATUS: DONE`; no primitive needed to express it
 *   stop        = `hlao close`
 *
 * Nothing here re-arms a timer on the supervisor side. If the loop dies, the
 * monitoring stops, which is the correct failure.
 */
import {
  closeQuietly,
  envRecord,
  hlao,
  parseExampleArgs,
  requireOk,
} from "./lib.mjs";

const { options, positionals } = parseExampleArgs(process.argv.slice(2));
const backend = options.backend ?? positionals[0] ?? "claude";
const interval = options.interval ?? "30s";
const maxChecks = Number(options["max-checks"] ?? 100);
const prompt =
  options.prompt ??
  'Check the monitored job. Reply with exactly "STATUS: DONE" when it has finished, otherwise "STATUS: RUNNING".';
const spawnEnv = options.env ?? [];
const envArgs = spawnEnv.flatMap((pair) => ["--env", pair]);

function isDone(text) {
  return /STATUS:\s*DONE/i.test(text ?? "");
}

console.log(
  `cron assembly · backend ${backend} · interval ${interval} · max ${maxChecks} checks`,
);

const spawned = requireOk(
  await hlao(["spawn", backend, prompt, "--wait", ...envArgs]),
  "spawn monitor",
);
const id = spawned.session.id;
if (spawned.firstTurn?.timedOut) {
  throw new Error("the first check did not finish in time");
}
console.log(`monitor ${id}`);

let checks = 0;
let text = spawned.firstTurn?.text ?? "";
for (;;) {
  checks += 1;
  console.log(`check ${checks}: ${text || "(no text)"}`);
  if (isDone(text)) break;
  if (checks >= maxChecks) {
    console.error(`gave up after ${checks} checks; closing ${id}`);
    await closeQuietly(id);
    process.exit(1);
  }

  // The timer: one bounded wait. Exit code 2 is the expected path.
  const slept = await hlao(["wait", id, "--until", "change", "--timeout", interval]);
  if (slept.code !== 0 && slept.code !== 2) {
    throw new Error(
      `wait failed: ${slept.value?.error?.message ?? slept.stderr.trim()}`,
    );
  }

  const sent = requireOk(await hlao(["send", id, prompt, "--wait"]), "check");
  text = sent.text ?? "";
}

console.log(`done after ${checks} check${checks === 1 ? "" : "s"}; closing ${id}`);
await closeQuietly(id);
