import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type SpawnValue, type WaitValue } from "./harness.js";

test("wait --until idle does not resolve between queued turns", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "first",
    "--env",
    "FAKE_MODE=slow",
    "--env",
    "FAKE_DELAY_MS=1200",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  // The first turn is slow; this message is queued behind it.
  const sent = await harness.json(["send", id, "second"]);
  assert.equal(sent.code, 0);

  const waited = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "30s",
  ]);
  assert.equal(waited.code, 0);
  assert.equal(waited.value.satisfied, true);
  assert.equal(waited.value.session.status, "idle");
  assert.equal(waited.value.session.queued, 0);
  assert.equal(waited.value.session.settled, true);
  assert.ok(
    waited.value.session.turn >= 2,
    `expected both queued turns to finish, saw turn ${waited.value.session.turn}`,
  );
});

test("the CLI settles only after the queue drains", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "first",
    "--env",
    "FAKE_MODE=slow",
    "--env",
    "FAKE_DELAY_MS=1200",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  await harness.json(["send", id, "second"]);

  // `settled` is the completion condition: it cannot resolve while the second
  // turn is still queued. This is the same wait the CLI's `idle` now uses.
  const waited = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "settled",
    "--timeout",
    "30s",
  ]);
  assert.equal(waited.code, 0);
  assert.equal(waited.value.reason, "idle");
  assert.equal(waited.value.session.queued, 0);
  assert.ok(waited.value.session.turn >= 2);
});
