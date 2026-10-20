import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  waitFor,
  type ElicitValue,
  type GetValue,
  type ReadValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

function messageText(read: ReadValue, prefix: string): boolean {
  return read.events.some(
    (event) =>
      event.type === "agent.message" &&
      typeof event.data.text === "string" &&
      event.data.text.startsWith(prefix),
  );
}

test("a form elicitation is advertised, parked, and answered with content", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=elicitation",
  ]);
  const id = spawned.value.session.id;

  const waited = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);
  assert.equal(waited.code, 0);
  assert.equal(waited.value.reason, "permission");
  assert.equal(waited.value.session.status, "waiting_permission");
  const pending = waited.value.session.pendingElicitation;
  assert.ok(pending, "pendingElicitation is exposed");
  assert.equal(pending?.mode, "form");
  assert.equal(pending?.message, "Choose a build");
  const schema = pending?.requestedSchema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  assert.ok(schema?.properties?.question_0, "the form schema is exposed");
  assert.deepEqual(schema?.required, ["question_0"]);

  const before = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    messageText(before.value, "capability: form"),
    "the adapter saw the form capability",
  );
  const requested = before.value.events.find(
    (event) => event.type === "elicitation.requested",
  );
  assert.ok(requested, "elicitation.requested was emitted");
  assert.equal(requested?.data.message, "Choose a build");
  assert.equal(requested?.data.mode, "form");

  const answered = await harness.json<ElicitValue>([
    "elicit",
    id,
    "--accept",
    "question_0=build-a",
  ]);
  assert.equal(answered.code, 0);
  assert.equal(answered.value.action, "accept");
  assert.equal(answered.value.requestId, pending?.requestId);

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return messageText(read.value, 'elicitation: accept {"question_0":"build-a"}');
  }, "the accepted content to reach the provider");

  await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  const after = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const resolved = after.value.events.find(
    (event) => event.type === "elicitation.resolved",
  );
  assert.equal(resolved?.data.action, "accept");
  assert.equal(resolved?.data.by, "operator");
});

test("decline answers without content", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=elicitation",
  ]);
  const id = spawned.value.session.id;
  await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);

  const answered = await harness.json<ElicitValue>(["elicit", id, "--decline"]);
  assert.equal(answered.code, 0);
  assert.equal(answered.value.action, "decline");

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return messageText(read.value, "elicitation: decline");
  }, "the decline to reach the provider");
});

test("cancel answers the provider with cancel", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=elicitation",
  ]);
  const id = spawned.value.session.id;
  await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);

  const answered = await harness.json<ElicitValue>(["elicit", id, "--cancel"]);
  assert.equal(answered.code, 0);
  assert.equal(answered.value.action, "cancel");

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return messageText(read.value, "elicitation: cancel");
  }, "the cancel to reach the provider");
});

test("a provider-withdrawn elicitation clears its pending state", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=elicitation-withdrawn",
  ]);
  const id = spawned.value.session.id;

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return read.value.events.some(
      (event) =>
        event.type === "elicitation.resolved" &&
        event.data.reason === "withdrawn",
    );
  }, "the provider to withdraw its question");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    read.value.events.some((event) => event.type === "elicitation.requested"),
    "the question was surfaced before it was withdrawn",
  );
  const resolved = read.value.events.find(
    (event) => event.type === "elicitation.resolved",
  );
  assert.equal(resolved?.data.action, "cancel");
  assert.equal(resolved?.data.by, "agent");

  const after = await harness.json<GetValue>(["get", id]);
  assert.equal(after.value.session.pendingElicitation, null);
});
