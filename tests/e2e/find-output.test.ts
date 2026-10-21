import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

test("find prints a readable match line with time, label, and seq", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "search target",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const result = await harness.run(["find", "echo:"], { json: false });
  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    new RegExp(`› \\d{2}:\\d{2}:\\d{2}  .*\\(${id}\\)  #\\d+  agent\\.message  echo:`),
  );
  assert.match(result.stdout, /1 match in 1 session/);
});

test("find --context shows neighbors around a match", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "context target",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const result = await harness.run(
    ["find", "echo:", "--context", "1"],
    { json: false },
  );
  assert.equal(result.code, 0);
  const lines = result.stdout.split("\n");
  const matchIndex = lines.findIndex((line) => line.startsWith("›"));
  assert.ok(matchIndex >= 0, result.stdout);
  assert.ok(lines[matchIndex - 1]?.startsWith("  "), "a before-context line");
  assert.ok(lines[matchIndex + 1]?.startsWith("  "), "an after-context line");
});

test("find --regex and time filters are bounded by the same read filters", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "regex target",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const anchored = await harness.json<{ count: number }>([
    "find",
    "prompt[.]sent",
    "--type",
    "prompt.sent",
    "--regex",
  ]);
  assert.equal(anchored.code, 0);
  assert.equal(anchored.value.count, 1);

  const recent = await harness.json<{ count: number }>([
    "find",
    "echo:",
    "--after",
    "1h",
  ]);
  assert.equal(recent.code, 0);
  assert.equal(recent.value.count, 1);

  const old = await harness.json<{ count: number }>([
    "find",
    "echo:",
    "--until",
    "1h",
  ]);
  assert.equal(old.code, 0);
  assert.equal(old.value.count, 0);

  const bad = await harness.run(["find", "[", "--regex"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /regular expression|Invalid regular expression/);
});
