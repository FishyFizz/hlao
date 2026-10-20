import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type PermitValue,
  type ReadValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

interface QueueValue {
  session: { id: string; queued: number };
  active: {
    position: null;
    textPreview: string;
    from: string;
    turn: number | null;
  } | null;
  queue: {
    position: number | null;
    textPreview: string;
    textLength: number;
    from: string;
    queuedMs: number;
    turn: number | null;
  }[];
}

interface QueueDropValue {
  session: { id: string; queued: number };
  dropped: { position: number | null; textPreview: string };
  discarded: number;
}

async function spawnParent(
  harness: Harness,
  name: string,
): Promise<{ id: string; env: Record<string, string> }> {
  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "parent turn",
    "--name",
    name,
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  return { id, env: { HLAO_SESSION_ID: id, HLAO_NAME: name } };
}

async function waitForBusy(harness: Harness, id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await harness.json<ReadValue>(["read", id]);
    if (read.value.session.status === "busy") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session ${id} never became busy`);
}

test("policy reads and writes live state and records the actor", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await spawnParent(harness, "parent");
  const child = await harness.json<SpawnValue>(["spawn", "fake", "child", "--wait"], {
    env: parent.env,
  });
  assert.equal(child.code, 0);
  const childId = child.value.session.id;

  const read = await harness.json<{ session: { permissionPolicy: string } }>([
    "policy",
    childId,
  ]);
  assert.equal(read.code, 0);
  assert.equal(read.value.session.permissionPolicy, "allow");

  const set = await harness.json<{ session: { permissionPolicy: string } }>([
    "policy",
    childId,
    "ask",
  ], { env: parent.env });
  assert.equal(set.code, 0);
  assert.equal(set.value.session.permissionPolicy, "ask");

  const history = await harness.json<ReadValue>([
    "read",
    childId,
    "--since",
    "0",
  ]);
  const changed = history.value.events.find(
    (event) =>
      event.type === "policy.changed" &&
      event.data.permissionPolicy === "ask",
  );
  assert.equal(changed?.data.by, parent.id);

  const self = await harness.json<{ session: { permissionPolicy: string } }>(
    ["policy"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(self.code, 0);
  assert.equal(self.value.session.permissionPolicy, "ask");
});

test("permissions, modes, renames, cancels, and closes attribute the actor", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await spawnParent(harness, "supervisor-parent");

  const gated = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "gate",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ], { env: parent.env });
  assert.equal(gated.code, 0);
  const gatedId = gated.value.session.id;

  const waited = await harness.json<WaitValue>([
    "wait",
    gatedId,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);
  assert.equal(waited.code, 0);

  const permitted = await harness.json<PermitValue>(
    ["permit", gatedId, "--allow"],
    { env: parent.env },
  );
  assert.equal(permitted.code, 0);
  assert.equal(permitted.value.by, parent.id);

  const gatedHistory = await harness.json<ReadValue>([
    "read",
    gatedId,
    "--since",
    "0",
  ]);
  const resolved = gatedHistory.value.events.find(
    (event) => event.type === "permission.resolved" && event.data.optionId === "allow",
  );
  assert.equal(resolved?.data.by, parent.id);

  const worker = await harness.json<SpawnValue>(["spawn", "fake", "work", "--wait"], {
    env: parent.env,
  });
  const workerId = worker.value.session.id;

  const renamed = await harness.json(["rename", workerId, "renamed-child"], {
    env: parent.env,
  });
  assert.equal(renamed.code, 0);
  const mode = await harness.json(["mode", workerId, "auto"], {
    env: parent.env,
  });
  assert.equal(mode.code, 0);

  const active = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hold",
    "--env",
    "FAKE_MODE=never",
  ], { env: parent.env });
  const activeId = active.value.session.id;
  await waitForBusy(harness, activeId);
  const cancelled = await harness.json<{ discarded: number }>(
    ["cancel", activeId],
    { env: parent.env },
  );
  assert.equal(cancelled.code, 0);

  const idle = await harness.json<SpawnValue>(["spawn", "fake", "idle", "--wait"], {
    env: parent.env,
  });
  const idleId = idle.value.session.id;
  const closed = await harness.json(["close", idleId], { env: parent.env });
  assert.equal(closed.code, 0);

  const workerHistory = await harness.json<ReadValue>(["read", workerId]);
  assert.equal(
    workerHistory.value.events.find((event) => event.type === "session.renamed")
      ?.data.by,
    parent.id,
  );
  assert.ok(
    workerHistory.value.events.some(
      (event) => event.type === "mode" && event.data.by === parent.id,
    ),
  );

  const activeHistory = await harness.json<ReadValue>(["read", activeId]);
  assert.equal(
    activeHistory.value.events.find((event) => event.type === "cancel.requested")
      ?.data.by,
    parent.id,
  );

  const idleHistory = await harness.json<ReadValue>(["read", idleId]);
  assert.equal(
    idleHistory.value.events.find((event) => event.type === "session.closed")
      ?.data.by,
    parent.id,
  );
});

test("a child can address its parent, grandparent, and siblings", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const root = await spawnParent(harness, "root");
  const middle = await harness.json<SpawnValue>(["spawn", "fake", "middle", "--wait"], {
    env: root.env,
  });
  const middleId = middle.value.session.id;
  const child = await harness.json<SpawnValue>(["spawn", "fake", "child", "--wait"], {
    env: { HLAO_SESSION_ID: middleId },
  });
  const childId = child.value.session.id;

  const sent = await harness.json<{ completed: boolean; text?: string }>(
    ["send", middleId, "report from child", "--wait", "--timeout", "10s"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(sent.code, 0);
  assert.equal(sent.value.completed, true);
  assert.match(sent.value.text ?? "", /echo: report from child/);

  const parentHistory = await harness.json<ReadValue>(["read", middleId]);
  const prompt = parentHistory.value.events.find(
    (event) =>
      event.type === "prompt.sent" &&
      event.data.text === "report from child",
  );
  assert.equal(prompt?.data.text, "report from child");
  assert.equal(prompt?.data.from, childId);

  // Universal addressing: the parent is readable and waitable.
  const parentRead = await harness.json<ReadValue>(["read", middleId], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.equal(parentRead.code, 0);
  assert.ok(parentRead.value.events.length > 0);

  const parentWait = await harness.json<{ satisfied: boolean }>(
    ["wait", middleId, "--timeout", "1s"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(parentWait.code, 0);
  assert.equal(parentWait.value.satisfied, true);

  // A generation skip is addressable too.
  const grandparent = await harness.json<{ completed: boolean }>(
    ["send", root.id, "skip a generation", "--wait", "--timeout", "10s"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(grandparent.code, 0);
  assert.equal(grandparent.value.completed, true);

  const sibling = await harness.json<SpawnValue>(["spawn", "fake", "sibling", "--wait"], {
    env: { HLAO_SESSION_ID: middleId },
  });
  const siblingSend = await harness.json<{ completed: boolean }>(
    ["send", sibling.value.session.id, "sibling message", "--wait", "--timeout", "10s"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(siblingSend.code, 0);
  assert.equal(siblingSend.value.completed, true);
});

test("queue inspection, drop, and keep-queue cancel", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "active turn",
    "--env",
    "FAKE_MODE=slow-first",
    "--env",
    "FAKE_DELAY_MS=5000",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  await waitForBusy(harness, id);

  const first = await harness.json(["send", id, "first queued"]);
  assert.equal(first.code, 0);
  const second = await harness.json(["send", id, "second queued"]);
  assert.equal(second.code, 0);

  const listed = await harness.json<QueueValue>(["queue", id]);
  assert.equal(listed.code, 0);
  assert.ok(listed.value.active);
  assert.equal(listed.value.queue.length, 2);
  assert.equal(listed.value.queue[0]?.position, 1);
  assert.equal(listed.value.queue[0]?.textPreview, "first queued");
  assert.equal(listed.value.queue[0]?.from, "operator");
  assert.equal(listed.value.queue[1]?.textPreview, "second queued");

  const dropped = await harness.json<QueueDropValue>(["queue", "drop", id, "1"]);
  assert.equal(dropped.code, 0);
  assert.equal(dropped.value.dropped.position, 1);
  assert.equal(dropped.value.dropped.textPreview, "first queued");
  assert.equal(dropped.value.discarded, 1);

  const remaining = await harness.json<QueueValue>(["queue", id]);
  assert.equal(remaining.value.queue.length, 1);
  assert.equal(remaining.value.queue[0]?.textPreview, "second queued");

  const cancelled = await harness.json<{ discarded: number }>([
    "cancel",
    id,
    "--keep-queue",
  ]);
  assert.equal(cancelled.code, 0);
  assert.equal(cancelled.value.discarded, 0);

  const idle = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(idle.code, 0);

  const history = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const discard = history.value.events.find(
    (event) =>
      event.type === "prompt.discarded" && event.data.reason === "dropped",
  );
  assert.equal(discard?.data.text, "first queued");
  assert.equal(discard?.data.by, "operator");
  const cancel = history.value.events.find(
    (event) => event.type === "cancel.requested",
  );
  assert.equal(cancel?.data.keepQueue, true);
  const ran = history.value.events.find(
    (event) =>
      event.type === "prompt.sent" && event.data.text === "second queued",
  );
  assert.ok(ran);
  assert.equal(ran?.data.from, "operator");
});

test("provider config options can be selected at spawn and changed live", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "configured",
    "--model",
    "opus",
    "--config",
    "verbose=true",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  const options = spawned.value.session.configOptions ?? [];
  const model = options.find((option) => option.id === "model");
  const verbose = options.find((option) => option.id === "verbose");
  assert.equal(model?.currentValue, "opus");
  assert.equal(verbose?.currentValue, true);

  const listed = await harness.json<{
    session: { configOptions: typeof options };
  }>(["option", id]);
  assert.equal(listed.code, 0);
  assert.equal(
    listed.value.session.configOptions?.find((option) => option.id === "model")
      ?.currentValue,
    "opus",
  );

  const setModel = await harness.json<{
    session: { configOptions: typeof options };
  }>(["option", id, "model", "sonnet"]);
  assert.equal(setModel.code, 0);
  assert.equal(
    setModel.value.session.configOptions?.find((option) => option.id === "model")
      ?.currentValue,
    "sonnet",
  );

  const setVerbose = await harness.json<{
    session: { configOptions: typeof options };
  }>(["option", id, "verbose", "false"]);
  assert.equal(setVerbose.code, 0);
  assert.equal(
    setVerbose.value.session.configOptions?.find(
      (option) => option.id === "verbose",
    )?.currentValue,
    false,
  );

  const invalid = await harness.json<JsonError>(["option", id, "model", "giant"]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.value.error.code, "bad_option");

  const missing = await harness.json<JsonError>([
    "spawn",
    "fake",
    "no model",
    "--env",
    "FAKE_NO_CONFIG=1",
    "--model",
    "sonnet",
  ]);
  assert.equal(missing.code, 1);
  assert.equal(missing.value.error.code, "bad_request");
  assert.match(missing.value.error.message, /model option/);

  const noOptions = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "plain",
    "--env",
    "FAKE_NO_CONFIG=1",
    "--wait",
  ]);
  assert.equal(noOptions.code, 0);
  const plain = await harness.json<{
    session: { configOptions: unknown };
  }>(["option", noOptions.value.session.id]);
  assert.equal(plain.value.session.configOptions, null);
});

test("close --tree --dry-run reports without closing anything", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await spawnParent(harness, "tree-dry-parent");
  const child = await harness.json<SpawnValue>(
    ["spawn", "fake", "child", "--wait"],
    { env: parent.env },
  );
  assert.equal(child.code, 0);
  const childId = child.value.session.id;

  const dry = await harness.json<{
    dryRun: boolean;
    count: number;
    sessions: { id: string; status: string }[];
  }>(["close", parent.id, "--tree", "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.count, 2);
  assert.deepEqual(
    new Set(dry.value.sessions.map((session) => session.id)),
    new Set([parent.id, childId]),
  );

  const after = await harness.json<{
    sessions: { id: string; status: string }[];
  }>(["list", "--all"]);
  const byId = new Map(
    after.value.sessions.map((session) => [session.id, session.status]),
  );
  assert.equal(byId.get(parent.id), "idle");
  assert.equal(byId.get(childId), "idle");
});

test("changing policy answers a parked permission", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "ask first",
    "--permission",
    "ask",
    "--env",
    "FAKE_MODE=permission",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const waiting = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "15s",
  ]);
  assert.equal(waiting.code, 0);
  assert.ok(waiting.value.session.pendingPermission);

  const allowed = await harness.json<{
    session: {
      status: string;
      permissionPolicy: string;
      pendingPermission: unknown;
    };
  }>(["policy", id, "allow"]);
  assert.equal(allowed.code, 0);
  assert.equal(allowed.value.session.permissionPolicy, "allow");
  assert.equal(allowed.value.session.pendingPermission, null);
  assert.notEqual(allowed.value.session.status, "waiting_permission");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const resolved = read.value.events.find(
    (event) => event.type === "permission.resolved",
  );
  assert.ok(resolved);
  assert.equal(resolved.data.by, "operator");
  assert.equal(typeof resolved.data.optionId, "string");
});
