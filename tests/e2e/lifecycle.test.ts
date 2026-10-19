import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type CloseValue,
  type JsonError,
  type ListValue,
  type ReadValue,
  type SendValue,
  type SpawnValue,
} from "./harness.js";

test("a session is spawned, read, sent to, and closed", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello world",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  assert.match(id, /^[0-9abcdefghjkmnpqrstvwxyz]{6}$/);
  assert.equal(spawned.value.session.status, "idle");
  assert.equal(spawned.value.session.parentId, null);
  assert.equal(spawned.value.session.depth, 0);
  assert.deepEqual(spawned.value.firstTurn, {
    stopReason: "end_turn",
    text: "echo: hello world",
    timedOut: false,
  });
  assert.ok(spawned.value.session.lastSeq > 0);

  const listed = await harness.json<ListValue>(["list"]);
  assert.equal(listed.value.scope, "operator");
  assert.ok(listed.value.sessions.some((session) => session.id === id));

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const types = read.value.events.map((event) => event.type);
  for (const expected of [
    "session.created",
    "session.initialized",
    "prompt.sent",
    "turn.started",
    "agent.message",
    "turn.ended",
  ]) {
    assert.ok(types.includes(expected), `missing ${expected}`);
  }
  assert.equal(read.value.truncated, false);
  assert.ok(
    read.value.events.some((event) => event.type === "agent.thought"),
    "the adapter's thought should be recorded as an event",
  );

  const sent = await harness.json<SendValue>(["send", id, "again", "--wait"]);
  assert.equal(sent.code, 0);
  assert.equal(sent.value.completed, true);
  assert.equal(sent.value.text, "echo: again");
  assert.equal(sent.value.stopReason, "end_turn");

  const prefix = await harness.json<ReadValue>([
    "read",
    id.slice(0, 4),
    "--limit",
    "1",
  ]);
  assert.equal(prefix.value.session.id, id);

  const closed = await harness.json<CloseValue>(["close", id]);
  assert.equal(closed.value.session.status, "closed");
  assert.equal(closed.value.wasTerminal, false);
  assert.ok(closed.value.session.endedAt);

  const closedAgain = await harness.json<CloseValue>(["close", id]);
  assert.equal(closedAgain.value.wasTerminal, true);

  const retained = await harness.json<ReadValue>(["read", id]);
  assert.equal(retained.value.session.status, "closed");

  const hidden = await harness.json<ListValue>(["list"]);
  assert.ok(!hidden.value.sessions.some((session) => session.id === id));

  const all = await harness.json<ListValue>(["list", "--all"]);
  assert.ok(all.value.sessions.some((session) => session.id === id));

  const afterClose = await harness.json<JsonError>(["send", id, "nope"]);
  assert.equal(afterClose.code, 1);
  assert.equal(afterClose.value.error.code, "session_closed");
});

test("unknown and bogus session ids are rejected clearly", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const missing = await harness.json<JsonError>(["read", "zzzzzz"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.value.error.code, "not_found");

  const spawned = await harness.json<SpawnValue>(["spawn", "fake"]);
  assert.equal(spawned.code, 0);

  const prefix = await harness.json<JsonError>([
    "read",
    spawned.value.session.id.slice(0, 2),
  ]);
  assert.equal(prefix.code, 0);
});

test("human output includes the session and a cursor hint", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "human", "--wait"]);
  const id = spawned.value.session.id;

  const human = await harness.run(["read", id, "--since", "0"], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, new RegExp(id));
  assert.match(human.stdout, /agent › echo: human/);
  assert.match(human.stdout, /turn 1 ended: end_turn/);
  const thinking = human.stdout.indexOf("thinking ›");
  const answer = human.stdout.indexOf("agent ›");
  assert.ok(thinking >= 0, "the thought should be rendered");
  assert.ok(thinking < answer, "the thought must render before the answer");

  const list = await harness.run(["list"], { json: false });
  assert.match(list.stdout, /ID\s+NAME\s+BACKEND\s+STATUS/);
  assert.match(list.stdout, new RegExp(id));
});
