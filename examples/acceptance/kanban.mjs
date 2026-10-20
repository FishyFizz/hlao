#!/usr/bin/env node
/**
 * Acceptance assembly 2 — kanban: shared work state across sessions.
 *
 * Human terms: a board on the wall. Cards are work items; columns are where a
 * card is; the shared state is the board itself, at a known place, readable by
 * anyone who walks in.
 *
 * Assembly:
 *   card        = the prompt that spawns a worker
 *   column      = the session's orchestration state (idle / busy / closed)
 *   board       = a file, named by path and announced by reference
 *   move card   = `hlao send`
 *   WIP limit   = how many workers the orchestrator chooses to spawn
 *   done        = append the result to the ledger, close the worker
 *
 * The ledger is passed to each worker as a path, never as a copy. A worker
 * spawned later reads the same file, so there are no late joiners missing the
 * rules — only the ordinary risk that a file goes stale.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  closeQuietly,
  configureExample,
  hlao,
  requireOk,
} from "./lib.mjs";

const { options } = configureExample(process.argv.slice(2));
const backend = options.backend ?? "claude";
const ledger = resolve(options.ledger ?? "board.md");
const tasks = (options.tasks ?? "audit the build,summarize the failure")
  .split(",")
  .map((task) => task.trim())
  .filter(Boolean);
const spawnEnv = options.env ?? [];
const envArgs = spawnEnv.flatMap((pair) => ["--env", pair]);

mkdirSync(dirname(ledger), { recursive: true });
writeFileSync(
  ledger,
  `# Board\n\nLedger: ${ledger}\n\n## Rules\n\n- One card per worker.\n- Read this file before acting; append a result when done.\n- The file is the shared fact; do not paraphrase it to another worker.\n\n## Results\n\n`,
);
console.log(`ledger: ${ledger}`);

for (const task of tasks) {
  const prompt = `You are the worker for the card: ${task}
The shared ledger is at ${ledger}. Read it if you can; it is the shared fact.
Do the card and reply with a single line starting "RESULT:".`;
  let id = null;
  try {
    const spawned = requireOk(
      await hlao(["spawn", backend, prompt, "--wait", ...envArgs]),
      "spawn worker",
    );
    id = spawned.session.id;

    // The board's columns are session status. Read them the same way a person
    // glances at the board; this is also the assembly's `list` step.
    const board = requireOk(await hlao(["list"]), "list");
    const card = board.sessions.find((session) => session.id === id);
    console.log(`worker ${id} · column ${card?.status ?? "unknown"}`);

    // Moving the card is a message, not a board mutation.
    const moved = requireOk(
      await hlao([
        "send",
        id,
        `The card is in progress. Finish it and reply with a single line starting "RESULT:".`,
        "--wait",
      ]),
      "move card",
    );
    const result = (moved.text ?? "").trim();
    appendFileSync(ledger, `- [${task}] worker ${id}: ${result}\n`);
    console.log(`card done: ${task} (${id})`);
  } finally {
    if (id !== null) await closeQuietly(id);
  }
}

console.log("\n--- board ---");
console.log(readFileSync(ledger, "utf8"));
