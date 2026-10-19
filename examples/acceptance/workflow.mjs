#!/usr/bin/env node
/**
 * Acceptance assembly 4 — dynamic workflow.
 *
 * Human terms: you ask someone to first check whether a task is possible, then
 * decide what to do with the answer. If they come back saying it cannot be
 * done, the job stops and the finding reaches you. Their finding changes the
 * plan; the plan was not fixed before they looked.
 *
 * Assembly:
 *   plan step   = `hlao spawn` at the moment the step is chosen
 *   finding     = `hlao read` of the scout's result
 *   branch      = this script's `if`
 *   dead end    = close the scout and stop; no primitive needs to know why
 *   next step   = a second spawn, only if the finding allows it
 *
 * The contrast with a frozen workflow is the whole point: the decision to
 * spawn the worker happens after the scout has seen the situation. A finding
 * of "impossible" has a path back to the orchestrator because the orchestrator
 * is still running and still free.
 */
import {
  closeQuietly,
  hlao,
  lastAgentText,
  parseExampleArgs,
  requireOk,
} from "./lib.mjs";

const { options, positionals } = parseExampleArgs(process.argv.slice(2));
const backend = options.backend ?? "claude";
const goal =
  options.goal ?? (positionals.length > 0 ? positionals.join(" ") : "ship the feature");
const spawnEnv = options.env ?? [];
const envArgs = spawnEnv.flatMap((pair) => ["--env", pair]);

console.log(`workflow · goal: ${goal}`);

const scoutPrompt = `Assess whether this task is possible before anyone commits to it:
${goal}
Reply with exactly "VERDICT: possible" or "VERDICT: impossible" and one reason.`;
const scout = requireOk(
  await hlao(["spawn", backend, scoutPrompt, "--wait", ...envArgs]),
  "spawn scout",
);
const scoutId = scout.session.id;
console.log(`scout ${scoutId}: ${scout.firstTurn?.text ?? "(no text)"}`);

const verdict = scout.firstTurn?.text ?? "";
if (/VERDICT:\s*impossible/i.test(verdict)) {
  console.log("finding returned to the orchestrator: the plan stops here.");
  await closeQuietly(scoutId);
  process.exit(0);
}

const workerPrompt = `The task has been judged possible. Do it:
${goal}
Reply with a single line starting "RESULT:".`;
const worker = requireOk(
  await hlao(["spawn", backend, workerPrompt, "--wait", ...envArgs]),
  "spawn worker",
);
const workerId = worker.session.id;
const read = requireOk(await hlao(["read", workerId, "--since", "0"]), "read worker");
console.log(`worker ${workerId}: ${lastAgentText(read)}`);

await closeQuietly(workerId);
await closeQuietly(scoutId);
console.log("workflow complete");
