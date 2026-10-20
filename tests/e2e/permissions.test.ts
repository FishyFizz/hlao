import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  waitFor,
  type GetValue,
  type JsonError,
  type PermitValue,
  type ReadValue,
  type SendValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

test("ask policy surfaces a pending permission until an operator answers", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ]);
  const id = spawned.value.session.id;
  assert.equal(spawned.value.session.status, "idle");

  const sent = await harness.json<SendValue>(["send", id, "run the build"]);
  assert.equal(sent.code, 0);
  assert.equal(sent.value.completed, false);

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
  assert.equal(waited.value.session.pendingPermission?.title, "Run the build");
  assert.deepEqual(
    waited.value.session.pendingPermission?.options.map((option) => option.kind),
    ["allow_once", "allow_always", "reject_once"],
  );

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    read.value.events.some((event) => event.type === "permission.requested"),
  );

  const permitted = await harness.json<PermitValue>([ "permit", id, "--allow" ]);
  assert.equal(permitted.code, 0);
  assert.equal(permitted.value.optionId, "allow");
  assert.equal(permitted.value.by, "operator");

  const idle = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(idle.value.reason, "idle");

  const after = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const resolved = after.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.equal(resolved?.data.optionId, "allow");
  assert.equal(resolved?.data.by, "operator");
  assert.ok(
    after.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permission: allow",
    ),
  );
});

test("deny picks a reject option and records it", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ]);
  const id = spawned.value.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);

  const permitted = await harness.json<PermitValue>(["permit", id, "--deny"]);
  assert.equal(permitted.value.optionId, "reject");
  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permission: reject",
    ),
  );
});

test("the allow policy answers without an operator", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "allow",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  assert.equal(spawned.value.firstTurn?.text, "permission: allow");

  const read = await harness.json<ReadValue>([
    "read",
    spawned.value.session.id,
    "--since",
    "0",
  ]);
  const requested = read.value.events.find(
    (event) => event.type === "permission.requested",
  );
  assert.equal(requested?.data.auto, true);
  const resolved = read.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.equal(resolved?.data.by, "policy:allow");
});

test("cancel resolves a pending permission instead of leaving it hanging", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ]);
  assert.equal(spawned.code, 0, JSON.stringify(spawned.value));
  const id = spawned.value.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);

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

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const resolved = read.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.equal(resolved?.data.optionId, null);
  assert.equal(resolved?.data.by, "operator");
  assert.equal(resolved?.data.reason, "cancel");
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permission: cancelled",
    ),
  );
});

test("a failed prompt clears its pending permission and returns to idle", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=permission-then-fail",
    "--permission",
    "ask",
  ]);
  const id = spawned.value.session.id;

  const sent = await harness.json<JsonError>([
    "send",
    id,
    "go",
    "--wait",
    "--timeout",
    "10s",
  ]);
  assert.equal(sent.code, 1);
  assert.equal(sent.value.error.code, "session_failed");

  const idle = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "5s",
  ]);
  assert.equal(idle.code, 0);
  assert.equal(idle.value.reason, "idle");
  assert.equal(idle.value.session.pendingPermission, null);
});

test("the default policy allows without parking the turn", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=permission",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  assert.equal(spawned.value.session.permissionPolicy, "allow");
  assert.equal(spawned.value.firstTurn?.text, "permission: allow");

  const read = await harness.json<ReadValue>([
    "read",
    spawned.value.session.id,
    "--since",
    "0",
  ]);
  const requested = read.value.events.find(
    (event) => event.type === "permission.requested",
  );
  assert.equal(requested?.data.auto, true);
  const resolved = read.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.equal(resolved?.data.by, "policy:allow");
});

test("permit --always switches the session policy and stops future prompts", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ]);
  const id = spawned.value.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);

  const permitted = await harness.json<PermitValue>(["permit", id, "--allow", "--always"]);
  assert.equal(permitted.value.optionId, "allow-always");
  assert.equal(permitted.value.session.permissionPolicy, "allow");

  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "policy.changed" && event.data.permissionPolicy === "allow",
    ),
  );

  const second = await harness.json<SendValue>([
    "send",
    id,
    "run again",
    "--wait",
    "--timeout",
    "10s",
  ]);
  assert.equal(second.code, 0);
  assert.equal(second.value.text, "permission: allow");
  assert.equal(second.value.session.pendingPermission, null);
});

test("an out-of-turn permission request is answered instead of cancelling the tool call", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=permission-after-turn",
    "--permission",
    "allow",
    "--wait",
  ]);
  const id = spawned.value.session.id;

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "late permission: allow",
    );
  }, "the agent's late permission to be answered");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const requested = read.value.events.find(
    (event) => event.type === "permission.requested",
  );
  assert.ok(requested, "permission.requested was emitted");
  assert.equal(requested?.data.auto, true);
  assert.equal(requested?.data.outsideTurn, true);
  const resolved = read.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.equal(resolved?.data.by, "policy:allow");
});

test("ask policy surfaces an out-of-turn permission for the operator", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=permission-after-turn",
    "--permission",
    "ask",
    "--wait",
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
  assert.equal(waited.value.session.status, "waiting_permission");
  assert.equal(
    waited.value.session.pendingPermission?.title,
    "Run the late build",
  );

  const permitted = await harness.json<PermitValue>(["permit", id, "--allow"]);
  assert.equal(permitted.value.optionId, "allow");

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "late permission: allow",
    );
  }, "the agent's late permission to be answered");
});

test("a provider-withdrawn permission clears its pending state", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "run",
    "--env",
    "FAKE_MODE=permission-withdrawn",
    "--permission",
    "ask",
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
  assert.equal(
    waited.value.session.pendingPermission?.title,
    "Run the withdrawn build",
  );

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return read.value.events.some(
      (event) =>
        event.type === "permission.resolved" &&
        event.data.reason === "withdrawn",
    );
  }, "the provider to withdraw its permission request");

  const after = await harness.json<GetValue>(["get", id]);
  assert.equal(after.value.session.pendingPermission, null);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const resolved = read.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.equal(resolved?.data.by, "agent");
  assert.equal(resolved?.data.reason, "withdrawn");
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permission: withdrawn",
    ),
  );
});

test("permit without a pending request is a typed error", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake"]);
  const id = spawned.value.session.id;
  const result = await harness.json<JsonError>(["permit", id, "--allow"]);
  assert.equal(result.code, 1);
  assert.equal(result.value.error.code, "no_pending_permission");

  const get = await harness.json<GetValue>(["read", id]);
  assert.equal(get.code, 0);
});
