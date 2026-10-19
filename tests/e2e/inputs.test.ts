import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type SendValue,
  type SpawnValue,
} from "./harness.js";

test("a first message can come from a file or stdin", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const promptFile = join(harness.home, "prompt.txt");
  writeFileSync(promptFile, "from a file\n");

  const fromFile = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--prompt-file",
    promptFile,
    "--wait",
  ]);
  assert.equal(fromFile.code, 0);
  assert.equal(fromFile.value.firstTurn?.text, "echo: from a file");
  const id = fromFile.value.session.id;

  const fromStdin = await harness.json<SendValue>(
    ["send", id, "--stdin", "--wait"],
    { input: "piped message\n" },
  );
  assert.equal(fromStdin.code, 0);
  assert.equal(fromStdin.value.text, "echo: piped message");
});

test("conflicting message sources and missing files are rejected", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const conflict = await harness.json<JsonError>(
    ["spawn", "fake", "positional", "--stdin"],
    { input: "stdin" },
  );
  assert.equal(conflict.code, 1);
  assert.equal(conflict.value.error.code, "bad_request");

  const missing = await harness.json<JsonError>([
    "spawn",
    "fake",
    "--prompt-file",
    join(harness.home, "absent.txt"),
  ]);
  assert.equal(missing.code, 1);
  assert.equal(missing.value.error.code, "bad_request");

  const badCwd = await harness.json<JsonError>([
    "spawn",
    "fake",
    "--cwd",
    join(harness.home, "does-not-exist"),
  ]);
  assert.equal(badCwd.code, 1);
  assert.equal(badCwd.value.error.code, "bad_request");
});

test("global flags work before the command", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const jsonFirst = await harness.run(
    ["--json", "list", "--home", harness.home],
    { json: false },
  );
  assert.equal(jsonFirst.code, 0);
  const listed = JSON.parse(jsonFirst.stdout) as { scope: string };
  assert.equal(listed.scope, "operator");

  const homeFirst = await harness.run(
    ["--home", harness.home, "whoami"],
    { json: false },
  );
  assert.equal(homeFirst.code, 0);
  assert.match(homeFirst.stdout, /operator/);
});

test("per-command help is reachable and names the command", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const help = await harness.run(["help", "send"], { json: false });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /hlao send \[<id>\] \[message\]/);
  assert.match(help.stdout, /--wait/);
  assert.match(help.stdout, /--self/);
  assert.match(help.stdout, /A timeout exits 2/);
});
