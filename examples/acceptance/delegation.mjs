#!/usr/bin/env node
/**
 * Acceptance assembly 3 — subagent delegation.
 *
 * Human terms: hand a bounded task to a colleague, remember which pane they are
 * in, wait for them to finish, read the result, and integrate it.
 *
 * Assembly:
 *   delegation = `hlao spawn` (the parent holds the handle)
 *   joining    = the spawn prompt (the spawn *is* the delivery)
 *   wait       = `hlao wait` / `spawn --wait`
 *   transfer   = `hlao read`, then use the text in the parent's own work
 *   cleanup    = `hlao close`
 *
 * There is no subagent object: the child is a session the parent holds a
 * handle to, the same way a person remembers which terminal they opened.
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
const task =
  options.task ?? (positionals.length > 0 ? positionals.join(" ") : "Summarize the README");
const spawnEnv = options.env ?? [];
const envArgs = spawnEnv.flatMap((pair) => ["--env", pair]);

const joining = `You are a delegated worker. The parent needs one bounded result.
Task: ${task}
Reply with a single line starting "RESULT:".

The parent's picture is partial: it gave you only this task and this directory.
If you need a fact that is not here, say what is missing rather than guessing.`;

console.log(`delegating to ${backend}: ${task}`);
const spawned = requireOk(
  await hlao(["spawn", backend, joining, "--wait", ...envArgs]),
  "spawn worker",
);
const id = spawned.session.id;
console.log(`worker ${id} · parent ${spawned.session.parentId ?? "(operator root)"}`);

const read = requireOk(await hlao(["read", id, "--since", "0"]), "read worker");
const result = lastAgentText(read);
console.log(`integrated result: ${result || "(the worker returned no text)"}`);

await closeQuietly(id);
console.log(`closed ${id}`);
