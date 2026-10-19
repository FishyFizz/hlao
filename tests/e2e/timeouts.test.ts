import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type SendValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

test("a wait timeout returns 2 and leaves the session alone", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake"]);
  const id = spawned.value.session.id;

  const waited = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "change",
    "--timeout",
    "200ms",
  ]);
  assert.equal(waited.code, 2);
  assert.equal(waited.value.satisfied, false);
  assert.equal(waited.value.reason, "timeout");
  assert.equal(waited.value.session.status, "idle");

  const exitWait = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "exit",
    "--timeout",
    "200ms",
  ]);
  assert.equal(exitWait.code, 2);
  assert.equal(exitWait.value.reason, "timeout");
});

test("send --wait can time out without cancelling the turn", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=slow",
    "--env",
    "FAKE_DELAY_MS=10000",
  ]);
  const id = spawned.value.session.id;

  const sent = await harness.json<SendValue>([
    "send",
    id,
    "long job",
    "--wait",
    "--timeout",
    "200ms",
  ]);
  assert.equal(sent.code, 2);
  assert.equal(sent.value.timedOut, true);
  assert.equal(sent.value.completed, false);
  assert.equal(sent.value.turn, 1);
  assert.equal(sent.value.session.status, "busy");

  await harness.json(["cancel", id]);
  const idle = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(idle.value.reason, "idle");
});
