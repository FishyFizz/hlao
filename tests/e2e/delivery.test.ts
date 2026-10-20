import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type ListValue,
  type ReadValue,
  type SendValue,
  type SpawnValue,
} from "./harness.js";

interface QueueValue {
  session: { id: string; queued: number };
  active: { id: string; textPreview: string } | null;
  queue: {
    id: string;
    position: number | null;
    textPreview: string;
  }[];
}

interface QueueDropValue {
  session: { id: string; queued: number };
  dropped: { id: string; position: number | null; textPreview: string };
  discarded: number;
}

const MESSAGE_ID = /^msg-[0-9abcdefghjkmnpqrstvwxyz]{8}$/;

async function waitForBusy(harness: Harness, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await harness.json<ReadValue>(["read", id]);
    if (read.value.session.status === "busy") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session ${id} never became busy`);
}

async function waitForQueue(
  harness: Harness,
  id: string,
  length: number,
): Promise<QueueValue> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await harness.json<QueueValue>(["queue", id]);
    if (listed.value.queue.length === length) return listed.value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session ${id} never reached a queue length of ${length}`);
}

test("message ids are stable, idempotent, and droppable by id", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=slow-first",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const first = await harness.json<SendValue>([
    "send",
    id,
    "one",
    "--idempotency-key",
    "key-1",
  ]);
  assert.equal(first.code, 0);
  assert.match(first.value.messageId, MESSAGE_ID);

  // A retry with the same key returns the original id and enqueues nothing.
  const retry = await harness.json<SendValue>([
    "send",
    id,
    "one",
    "--idempotency-key",
    "key-1",
  ]);
  assert.equal(retry.code, 0);
  assert.equal(retry.value.duplicate, true);
  assert.equal(retry.value.messageId, first.value.messageId);

  const afterRetry = await waitForQueue(harness, id, 0);
  assert.equal(afterRetry.active?.id, first.value.messageId);

  const second = await harness.json<SendValue>(["send", id, "two"]);
  assert.equal(second.code, 0);
  assert.match(second.value.messageId, MESSAGE_ID);
  assert.equal(second.value.queued, true);

  const queued = await waitForQueue(harness, id, 1);
  assert.equal(queued.queue[0]?.id, second.value.messageId);

  const dropped = await harness.json<QueueDropValue>([
    "queue",
    "drop",
    id,
    "--id",
    second.value.messageId,
  ]);
  assert.equal(dropped.code, 0);
  assert.equal(dropped.value.dropped.id, second.value.messageId);
  assert.equal(dropped.value.dropped.textPreview, "two");

  const empty = await waitForQueue(harness, id, 0);
  assert.equal(empty.active?.id, first.value.messageId);
});

test("a queued message cancelled before it runs reports cancelled", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=slow-first",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  await harness.json<SendValue>(["send", id, "active"]);
  await waitForBusy(harness, id);
  const waiting = harness.json<SendValue>(["send", id, "queued", "--wait"]);
  await waitForQueue(harness, id, 1);

  const cancelled = await harness.json(["cancel", id]);
  assert.equal(cancelled.code, 0);

  const result = await waiting;
  assert.equal(result.code, 0);
  assert.equal(result.value.outcome, "cancelled");
  assert.equal(result.value.completed, true);
  assert.equal(result.value.turn, null);
  assert.equal(result.value.timedOut, false);
});

test("spawn deduplicates by key and records the requester", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const first = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
    "--idempotency-key",
    "spawn-1",
  ]);
  assert.equal(first.code, 0);
  assert.match(first.value.messageId ?? "", MESSAGE_ID);
  assert.equal(first.value.session.createdBy, "operator");
  assert.equal(first.value.createdBy, "operator");
  assert.equal(first.value.duplicate, undefined);

  const retry = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
    "--idempotency-key",
    "spawn-1",
  ]);
  assert.equal(retry.code, 0);
  assert.equal(retry.value.duplicate, true);
  assert.equal(retry.value.session.id, first.value.session.id);
  assert.equal(retry.value.messageId, first.value.messageId);

  const listed = await harness.json<ListValue>(["list"]);
  assert.equal(listed.value.sessions.length, 1);

  // A session caller is named as the requester, in the view and the event.
  const parent = first.value.session;
  const child = await harness.json<SpawnValue>(["spawn", "fake", "hello", "--wait"], {
    env: { HLAO_SESSION_ID: parent.id },
  });
  assert.equal(child.code, 0);
  assert.equal(child.value.session.createdBy, parent.id);
  assert.equal(child.value.createdBy, parent.id);

  const read = await harness.json<ReadValue>([
    "read",
    child.value.session.id,
    "--since",
    "0",
  ]);
  const created = read.value.events.find((event) => event.type === "session.created");
  assert.ok(created);
  assert.equal(created.data.createdBy, parent.id);

  // Once the original is gone from the live table the key is released.
  await harness.json(["close", child.value.session.id]);
  await harness.json(["close", parent.id]);
  await harness.json(["forget", parent.id]);
  const fresh = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
    "--idempotency-key",
    "spawn-1",
  ]);
  assert.equal(fresh.code, 0);
  assert.notEqual(fresh.value.session.id, parent.id);
  assert.equal(fresh.value.duplicate, undefined);
});
