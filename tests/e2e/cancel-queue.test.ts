import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type CancelValue,
  type ListValue,
  type ReadValue,
  type SendValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

test("messages queue behind the active turn and cancel discards them", async (t) => {
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

  const first = await harness.json<SendValue>(["send", id, "first"]);
  assert.equal(first.value.queued, false);
  assert.equal(first.value.turn, 1);

  const second = await harness.json<SendValue>(["send", id, "second"]);
  assert.equal(second.value.queued, true);
  assert.equal(second.value.turn, null);

  const listed = await harness.json<ListValue>(["list"]);
  const view = listed.value.sessions.find((session) => session.id === id);
  assert.equal(view?.status, "busy");
  assert.equal(view?.queued, 1);

  const cancelled = await harness.json<CancelValue>(["cancel", id]);
  assert.equal(cancelled.code, 0);
  assert.equal(cancelled.value.discarded, 1);

  const idle = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(idle.value.reason, "idle");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const types = read.value.events.map((event) => event.type);
  assert.ok(types.includes("cancel.requested"));
  assert.ok(types.includes("prompt.discarded"));
  const ended = read.value.events.find((event) => event.type === "turn.ended");
  assert.equal(ended?.data.stopReason, "cancelled");
  assert.equal(read.value.session.status, "idle");
});
