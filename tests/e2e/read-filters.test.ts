import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type ReadValue, type SpawnValue } from "./harness.js";

test("read time filters bound the event stream", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "clock", "--wait"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const all = await harness.json<ReadValue>(["read", id, "--limit", "1000"]);
  assert.ok(all.value.events.length > 0);

  const recent = await harness.json<ReadValue>([
    "read",
    id,
    "--after",
    "1h",
    "--limit",
    "1000",
  ]);
  assert.equal(recent.value.events.length, all.value.events.length);

  const beforeWindow = await harness.json<ReadValue>(["read", id, "--until", "1h"]);
  assert.equal(beforeWindow.value.events.length, 0);

  const future = await harness.json<ReadValue>(["read", id, "--after", "now"]);
  assert.equal(future.value.events.length, 0);
});

test("read --regex changes grep from literal to expression", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "regex", "--wait"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  // A character class is a regex but not a literal; both filters read the same
  // "type + data" haystack.
  const regex = await harness.json<ReadValue>([
    "read",
    id,
    "--grep",
    "prompt[.]sent",
    "--regex",
  ]);
  assert.equal(regex.code, 0);
  assert.ok(regex.value.events.length >= 1);
  assert.ok(regex.value.events.every((event) => event.type === "prompt.sent"));

  const literal = await harness.json<ReadValue>([
    "read",
    id,
    "--grep",
    "prompt[.]sent",
  ]);
  assert.equal(literal.value.events.length, 0);
});

test("read --context returns neighbors and identifies the matches", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "context", "--wait"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const page = await harness.json<ReadValue>([
    "read",
    id,
    "--type",
    "tool.call",
    "--context",
    "1",
  ]);
  assert.equal(page.code, 0);
  assert.ok(page.value.matchedSeqs !== undefined);
  assert.ok(page.value.matchedSeqs!.length >= 1);
  assert.ok(
    page.value.events.some(
      (event) => !page.value.matchedSeqs!.includes(event.seq),
    ),
    "expected at least one context neighbor",
  );
  for (const seq of page.value.matchedSeqs!) {
    assert.ok(page.value.events.some((event) => event.seq === seq));
  }
});

test("invalid regex and inverted time windows are rejected", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "bad-filter", "--wait"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const badRegex = await harness.run(["read", id, "--grep", "[", "--regex"]);
  assert.equal(badRegex.code, 1);
  assert.match(badRegex.stdout, /regular expression/);

  const noRegexQuery = await harness.run(["read", id, "--regex"]);
  assert.equal(noRegexQuery.code, 1);
  assert.match(noRegexQuery.stdout, /requires --grep/);

  const inverted = await harness.run([
    "read",
    id,
    "--after",
    "1h",
    "--until",
    "2h",
  ]);
  assert.equal(inverted.code, 1);
  assert.match(inverted.stdout, /earlier than --until/);

  const badContext = await harness.run(["read", id, "--context", "2"]);
  assert.equal(badContext.code, 1);
  assert.match(badContext.stdout, /needs --grep, --type, or --turn/);
});
