import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type CloseValue,
  type JsonError,
  type ListValue,
  type ReadValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

test("read filters, jsonl, and backward paging work through the CLI", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "ask first",
    "--env",
    "FAKE_MODE=permission",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const toolCalls = await harness.json<ReadValue>([
    "read",
    id,
    "--since",
    "0",
    "--type",
    "tool.call",
  ]);
  assert.equal(toolCalls.code, 0);
  assert.ok(toolCalls.value.events.length >= 1);
  assert.ok(toolCalls.value.events.every((event) => event.type === "tool.call"));

  const permissions = await harness.json<ReadValue>([
    "read",
    id,
    "--since",
    "0",
    "--type",
    "permission.requested",
  ]);
  assert.equal(permissions.code, 0);
  assert.ok(
    permissions.value.events.every(
      (event) => event.type === "permission.requested",
    ),
  );

  const grepped = await harness.json<ReadValue>([
    "read",
    id,
    "--since",
    "0",
    "--grep",
    "run the build",
  ]);
  assert.equal(grepped.code, 0);
  assert.ok(grepped.value.events.length >= 2);
  assert.ok(
    grepped.value.events.every((event) =>
      JSON.stringify(event.data).toLowerCase().includes("run the build"),
    ),
  );

  const firstTurn = await harness.json<ReadValue>([
    "read",
    id,
    "--since",
    "0",
    "--turn",
    "1",
  ]);
  assert.equal(firstTurn.code, 0);
  assert.ok(firstTurn.value.events.length > 0);

  const jsonl = await harness.run(["read", id, "--jsonl"], {
    json: false,
  });
  assert.equal(jsonl.code, 0);
  const lines = jsonl.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const event = JSON.parse(line) as { seq: number; type: string };
    assert.equal(typeof event.seq, "number");
    assert.equal(typeof event.type, "string");
  }

  const tail = await harness.json<ReadValue>(["read", id, "--limit", "2"]);
  assert.equal(tail.code, 0);
  assert.ok(tail.value.nextBefore !== null);
  const older = await harness.json<ReadValue>([
    "read",
    id,
    "--before",
    String(tail.value.nextBefore),
    "--limit",
    "2",
  ]);
  assert.equal(older.code, 0);
  assert.ok(older.value.events.length > 0);
  assert.ok(
    older.value.events.every((event) => event.seq < tail.value.nextBefore!),
  );

  const conflict = await harness.json<JsonError>([
    "read",
    id,
    "--since",
    "1",
    "--before",
    "2",
  ]);
  assert.equal(conflict.code, 1);
  assert.equal(conflict.value.error.code, "bad_request");

  const unknown = await harness.json<JsonError>([
    "read",
    id,
    "--type",
    "not.an.event",
  ]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.value.error.code, "bad_request");
});

test("wait accepts a list of ids with any/all semantics", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const busy = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=slow",
    "--env",
    "FAKE_DELAY_MS=2500",
  ]);
  const idle = await harness.json<SpawnValue>(["spawn", "fake"]);
  assert.equal(busy.code, 0);
  assert.equal(idle.code, 0);
  const busyId = busy.value.session.id;
  const idleId = idle.value.session.id;

  const sent = await harness.json<{ queued: boolean }>(["send", busyId, "go"]);
  assert.equal(sent.code, 0);
  await waitForStatus(harness, busyId, "busy");

  const any = await harness.json<WaitValue>([
    "wait",
    busyId,
    idleId,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(any.code, 0);
  assert.equal(any.value.satisfied, true);
  assert.equal(any.value.results.length, 2);
  const idleResult = any.value.results.find(
    (entry) => entry.session.id === idleId,
  );
  assert.equal(idleResult?.satisfied, true);
  const busyResult = any.value.results.find(
    (entry) => entry.session.id === busyId,
  );
  assert.equal(busyResult?.satisfied, false);

  const all = await harness.json<WaitValue>([
    "wait",
    busyId,
    idleId,
    "--all",
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(all.code, 0);
  assert.ok(all.value.results.every((entry) => entry.satisfied));

  const timeout = await harness.json<WaitValue>([
    "wait",
    busyId,
    idleId,
    "--all",
    "--until",
    "permission",
    "--timeout",
    "1s",
  ]);
  assert.equal(timeout.code, 2);
  assert.equal(timeout.value.reason, "timeout");

  const since = await harness.json<JsonError>([
    "wait",
    busyId,
    idleId,
    "--until",
    "change",
    "--since",
    "1",
  ]);
  assert.equal(since.code, 1);
  assert.equal(since.value.error.code, "bad_request");

  const both = await harness.json<JsonError>([
    "wait",
    busyId,
    idleId,
    "--any",
    "--all",
  ]);
  assert.equal(both.code, 1);
  assert.equal(both.value.error.code, "bad_request");

  const closed = await harness.json<CloseValue>(["close", idleId, "--force"]);
  assert.equal(closed.code, 0);
  const lost = await harness.json<WaitValue>([
    "wait",
    busyId,
    idleId,
    "--all",
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(lost.code, 3);
  assert.equal(lost.value.reason, "exit");
  assert.equal(
    lost.value.results.find((entry) => entry.session.id === idleId)?.reason,
    "exit",
  );
});

test("list --usage reports the latest snapshot and an aggregate", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const listed = await harness.json<ListValue>(["list"]);
  assert.equal(listed.code, 0);
  const session = listed.value.sessions.find(
    (entry) => entry.id === spawned.value.session.id,
  );
  assert.ok(session);
  assert.deepEqual(session.usage, {
    used: 42,
    size: 200_000,
    cost: null,
    at: session.usage?.at,
  });

  const human = await harness.run(["list", "--usage"], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /CONTEXT\s+COST/);
  assert.match(human.stdout, /42\/200\.0k/);
  assert.match(human.stdout, /cost: none reported · context: latest per session/);
});

async function waitForStatus(
  harness: Harness,
  id: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await harness.json<ListValue>(["list"]);
    const session = listed.value.sessions.find((entry) => entry.id === id);
    if (session?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session ${id} never reached ${status}`);
}
