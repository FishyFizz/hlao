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

async function spawnPermission(
  harness: Harness,
  mode = "permission",
  env: Record<string, string> = {},
): Promise<SpawnValue> {
  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    `FAKE_MODE=${mode}`,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
  ]);
  assert.equal(spawned.code, 0, JSON.stringify(spawned.value));
  return spawned.value;
}

async function waitPermission(harness: Harness, id: string): Promise<WaitValue> {
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
  return waited.value;
}

test("a provider ask parks for the operator until it is answered", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  assert.equal(spawned.session.status, "idle");
  assert.deepEqual(spawned.session.pendingPermissions, []);

  const sent = await harness.json<SendValue>(["send", id, "run the build"]);
  assert.equal(sent.code, 0);
  assert.equal(sent.value.completed, false);

  const waited = await waitPermission(harness, id);
  assert.equal(waited.session.status, "waiting_permission");
  assert.equal(waited.session.pendingPermissions.length, 1);
  const pending = waited.session.pendingPermissions[0]!;
  assert.equal(pending.title, "Run the build");
  assert.deepEqual(
    pending.options.map((option) => option.kind),
    ["allow_once", "allow_always", "reject_once", "reject_always"],
  );

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const requested = read.value.events.find(
    (event) => event.type === "permission.requested",
  );
  assert.equal(requested?.data.queuePosition, 1);
  assert.equal("policy" in (requested?.data ?? {}), false);
  assert.equal("auto" in (requested?.data ?? {}), false);

  const permitted = await harness.json<PermitValue>(["permit", id, "--allow"]);
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

test("there is no default allow: an unanswered ask stays parked", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.equal(
    read.value.events.some((event) => event.type === "permission.resolved"),
    false,
  );
  assert.equal(read.value.session.pendingPermissions.length, 1);

  await harness.json(["cancel", id]);
  await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
});

test("deny picks a reject option and records it", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

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

test("--always selects the provider's always option and mutates no policy", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

  const permitted = await harness.json<PermitValue>([
    "permit",
    id,
    "--allow",
    "--always",
  ]);
  assert.equal(permitted.code, 0);
  assert.equal(permitted.value.optionId, "allow-always");

  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.equal(
    read.value.events.some(
      (event) => (event.type as string) === "policy.changed",
    ),
    false,
  );
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "permission.resolved" &&
        event.data.optionId === "allow-always" &&
        event.data.by === "operator",
    ),
  );

  // A new prompt asks again: no HLAO policy exists to answer it.
  const second = await harness.json<SendValue>(["send", id, "run again"]);
  assert.equal(second.code, 0);
  const again = await waitPermission(harness, id);
  assert.equal(again.session.pendingPermissions.length, 1);
  await harness.json(["cancel", id]);
  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
});

test("--deny --always selects reject_always", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

  const permitted = await harness.json<PermitValue>([
    "permit",
    id,
    "--deny",
    "--always",
  ]);
  assert.equal(permitted.code, 0);
  assert.equal(permitted.value.optionId, "reject-always");
  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permission: reject-always",
    ),
  );
});

test("--always fails closed when the provider omits that option", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness, "permission", {
    FAKE_NO_ALWAYS: "1",
  });
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

  const allow = await harness.json<JsonError>(["permit", id, "--allow", "--always"]);
  assert.equal(allow.code, 1);
  assert.equal(allow.value.error.code, "bad_option");
  const deny = await harness.json<JsonError>(["permit", id, "--deny", "--always"]);
  assert.equal(deny.code, 1);
  assert.equal(deny.value.error.code, "bad_option");

  // The request is still parked; no state was mutated by the failed attempts.
  const got = await harness.json<GetValue>(["get", id]);
  assert.equal(got.value.session.pendingPermissions.length, 1);

  await harness.json(["cancel", id]);
  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
});

test("cancel resolves a pending permission instead of leaving it hanging", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

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

  const spawned = await spawnPermission(harness, "permission-then-fail");
  const id = spawned.session.id;

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
  assert.deepEqual(idle.value.session.pendingPermissions, []);
});

test("an out-of-turn ask parks for the operator", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness, "permission-after-turn");
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run"]);

  const waited = await waitPermission(harness, id);
  assert.equal(waited.session.pendingPermissions[0]?.title, "Run the late build");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const requested = read.value.events.find(
    (event) => event.type === "permission.requested",
  );
  assert.equal(requested?.data.outsideTurn, true);

  const permitted = await harness.json<PermitValue>(["permit", id, "--allow"]);
  assert.equal(permitted.value.optionId, "allow");

  await waitFor(async () => {
    const after = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return after.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "late permission: allow",
    );
  }, "the agent's late permission to be answered");
});

test("a provider-withdrawn permission clears its pending state", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness, "permission-withdrawn");
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run"]);
  await waitPermission(harness, id);

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return read.value.events.some(
      (event) =>
        event.type === "permission.resolved" &&
        event.data.reason === "withdrawn",
    );
  }, "the provider to withdraw its permission request");

  const after = await harness.json<GetValue>(["get", id]);
  assert.deepEqual(after.value.session.pendingPermissions, []);

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

test("a provider withdrawal clears only its own queued request", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness, "permission-multi", {
    FAKE_PERMISSION_COUNT: "2",
    FAKE_WITHDRAW_FIRST: "1",
    FAKE_WITHDRAW_MS: "3000",
  });
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run both"]);

  const waited = await waitPermission(harness, id);
  assert.equal(waited.session.pendingPermissions.length, 2);

  await waitFor(async () => {
    const got = await harness.json<GetValue>(["get", id]);
    return got.value.session.pendingPermissions.length === 1;
  }, "only the withdrawn request to clear", 5_000);

  const got = await harness.json<GetValue>(["get", id]);
  assert.equal(got.value.session.pendingPermissions[0]?.title, "Parallel build 2");

  const permitted = await harness.json<PermitValue>(["permit", id, "--allow"]);
  assert.equal(permitted.value.optionId, "allow");
  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const withdrawn = read.value.events.find(
    (event) =>
      event.type === "permission.resolved" &&
      event.data.reason === "withdrawn",
  );
  assert.equal(withdrawn?.data.by, "agent");
  const answered = read.value.events.find(
    (event) =>
      event.type === "permission.resolved" && event.data.by === "operator",
  );
  assert.equal(answered?.data.optionId, "allow");
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        String(event.data.text).startsWith("permissions:"),
    ),
    JSON.stringify(read.value.events.map((event) => [event.type, event.data.text])),
  );
});

test("parallel asks queue and are answered individually", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness, "permission-multi", {
    FAKE_PERMISSION_COUNT: "2",
  });
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run both"]);

  const waited = await waitPermission(harness, id);
  assert.equal(waited.session.pendingPermissions.length, 2);
  const [first, second] = waited.session.pendingPermissions;
  assert.equal(first?.title, "Parallel build 1");
  assert.equal(second?.title, "Parallel build 2");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const positions = read.value.events
    .filter((event) => event.type === "permission.requested")
    .map((event) => event.data.queuePosition);
  assert.deepEqual(positions, [1, 2]);

  // Without --request the command is ambiguous and names the ids.
  const ambiguous = await harness.json<JsonError>(["permit", id, "--allow"]);
  assert.equal(ambiguous.code, 1);
  assert.equal(ambiguous.value.error.code, "bad_request");
  assert.match(ambiguous.value.error.message, new RegExp(second!.requestId));

  const one = await harness.json<PermitValue>([
    "permit",
    id,
    "--request",
    second!.requestId,
    "--deny",
  ]);
  assert.equal(one.code, 0);
  assert.equal(one.value.requestId, second!.requestId);

  const remaining = await harness.json<GetValue>(["get", id]);
  assert.deepEqual(
    remaining.value.session.pendingPermissions.map((entry) => entry.requestId),
    [first!.requestId],
  );

  const other = await harness.json<PermitValue>(["permit", id, "--allow"]);
  assert.equal(other.value.requestId, first!.requestId);

  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
  const after = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    after.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permissions: allow,reject",
    ),
  );
});

test("--all-pending answers the whole queue", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness, "permission-multi", {
    FAKE_PERMISSION_COUNT: "3",
  });
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run all three"]);
  const waited = await waitPermission(harness, id);
  assert.equal(waited.session.pendingPermissions.length, 3);

  const permitted = await harness.json<{ count: number; resolved: PermitValue[] }>([
    "permit",
    "--all-pending",
    "--allow",
  ]);
  assert.equal(permitted.code, 0);
  assert.equal(permitted.value.count, 3);

  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
  const list = await harness.json<{ sessions: unknown[] }>(["list", "--pending"]);
  assert.deepEqual(list.value.sessions, []);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permissions: allow,allow,allow",
    ),
  );
});

test("a full queue cancels the new request and records queue_full", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  harness.updateConfig((config) => {
    config.maxPendingPermissions = 1;
  });

  const spawned = await spawnPermission(harness, "permission-multi", {
    FAKE_PERMISSION_COUNT: "2",
  });
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run both"]);

  const waited = await waitPermission(harness, id);
  assert.equal(waited.session.pendingPermissions.length, 1);

  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    return read.value.events.some(
      (event) =>
        event.type === "permission.resolved" &&
        event.data.by === "system" &&
        event.data.reason === "queue_full",
    );
  }, "the queue-full resolution");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const overflow = read.value.events.find(
    (event) =>
      event.type === "permission.resolved" &&
      event.data.reason === "queue_full",
  );
  assert.equal(overflow?.data.optionId, null);
  assert.equal(overflow?.data.by, "system");

  await harness.json<PermitValue>(["permit", id, "--allow"]);
  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
  const after = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    after.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permissions: allow,cancelled",
    ),
  );
});

test("an unanswered ask fails closed at the deadline and never allows", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  harness.updateConfig((config) => {
    config.permissionTimeoutMs = 400;
  });

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

  // `wait --until idle` treats a permission stop as completion, so poll for
  // the deadline itself and then assert the request is gone and the turn ran.
  await waitFor(async () => {
    const got = await harness.json<GetValue>(["get", id]);
    return got.value.session.pendingPermissions.length === 0;
  }, "the permission deadline to resolve the request", 5_000);

  const idle = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(idle.code, 0);
  assert.deepEqual(idle.value.session.pendingPermissions, []);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const resolved = read.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.equal(resolved?.data.by, "timeout");
  assert.equal(resolved?.data.reason, "timeout");
  assert.equal(resolved?.data.optionId, "reject");
  assert.ok(
    read.value.events.some(
      (event) =>
        event.type === "agent.message" &&
        event.data.text === "permission: reject",
    ),
  );
});

test("permit and mode are operator-only from an agent shell", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await spawnPermission(harness);
  const id = spawned.session.id;
  await harness.json<SendValue>(["send", id, "run the build"]);
  await waitPermission(harness, id);

  const permitted = await harness.json<JsonError>(["permit", id, "--allow"], {
    env: { HLAO_SESSION_ID: id },
  });
  assert.equal(permitted.code, 1);
  assert.equal(permitted.value.error.code, "operator_only");

  const mode = await harness.json<JsonError>(["mode", id, "auto"], {
    env: { HLAO_SESSION_ID: id },
  });
  assert.equal(mode.code, 1);
  assert.equal(mode.value.error.code, "operator_only");

  const child = await harness.json<JsonError>(
    ["spawn", "fake", "--mode", "auto"],
    { env: { HLAO_SESSION_ID: id } },
  );
  assert.equal(child.code, 1);
  assert.equal(child.value.error.code, "operator_only");

  // The request is still parked for the operator.
  const got = await harness.json<GetValue>(["get", id]);
  assert.equal(got.value.session.pendingPermissions.length, 1);

  await harness.json(["cancel", id]);
  await harness.json<WaitValue>(["wait", id, "--until", "idle", "--timeout", "10s"]);
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
