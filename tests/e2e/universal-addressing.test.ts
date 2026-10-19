import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type CancelValue,
  type ListValue,
  type ReadValue,
  type SpawnValue,
} from "./harness.js";

test("a stale caller can still address and spawn; identity is attribution only", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const existing = await harness.json<SpawnValue>(["spawn", "fake", "existing", "--wait"]);
  const existingId = existing.value.session.id;
  const stale = "zzzzzz";

  const read = await harness.json<ReadValue>(["read", existingId], {
    env: { HLAO_SESSION_ID: stale },
  });
  assert.equal(read.code, 0);
  assert.ok(read.value.events.length > 0);

  const cancelled = await harness.json<CancelValue>(["cancel", existingId], {
    env: { HLAO_SESSION_ID: stale },
  });
  assert.equal(cancelled.code, 0);

  const spawned = await harness.json<SpawnValue>(
    ["spawn", "fake", "from stale", "--wait"],
    { env: { HLAO_SESSION_ID: stale } },
  );
  assert.equal(spawned.code, 0);
  assert.equal(spawned.value.session.parentId, null);
  assert.equal(spawned.value.session.depth, 0);
});

test("close --tree reaches live grandchildren through a closed intermediate", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const root = await harness.json<SpawnValue>(["spawn", "fake", "root", "--wait"]);
  const rootId = root.value.session.id;
  const middle = await harness.json<SpawnValue>(
    ["spawn", "fake", "middle", "--wait"],
    { env: { HLAO_SESSION_ID: rootId } },
  );
  const middleId = middle.value.session.id;
  const leaf = await harness.json<SpawnValue>(
    ["spawn", "fake", "leaf", "--wait"],
    { env: { HLAO_SESSION_ID: middleId } },
  );
  const leafId = leaf.value.session.id;

  const middleClose = await harness.json(["close", middleId]);
  assert.equal(middleClose.code, 0);

  const tree = await harness.json<{ count: number }>(["close", rootId, "--tree"]);
  assert.equal(tree.value.count, 2);

  const all = await harness.json<ListValue>(["list", "--all"]);
  const statuses = new Map(all.value.sessions.map((session) => [session.id, session.status]));
  assert.equal(statuses.get(rootId), "closed");
  assert.equal(statuses.get(middleId), "closed");
  assert.equal(statuses.get(leafId), "closed");
});

test("every session in the instance is addressable and list is instance-wide", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await harness.json<SpawnValue>(["spawn", "fake", "parent", "--wait"]);
  const parentId = parent.value.session.id;

  const sibling = await harness.json<SpawnValue>(["spawn", "fake", "sibling", "--wait"]);
  const siblingId = sibling.value.session.id;

  const child = await harness.json<SpawnValue>(
    ["spawn", "fake", "child", "--wait"],
    { env: { HLAO_SESSION_ID: parentId } },
  );
  assert.equal(child.code, 0);
  assert.equal(child.value.session.parentId, parentId);
  assert.equal(child.value.session.rootId, parentId);
  assert.equal(child.value.session.depth, 1);
  const childId = child.value.session.id;

  const grandchild = await harness.json<SpawnValue>(
    ["spawn", "fake", "grandchild", "--wait"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(grandchild.value.session.parentId, childId);
  assert.equal(grandchild.value.session.rootId, parentId);
  assert.equal(grandchild.value.session.depth, 2);
  const grandchildId = grandchild.value.session.id;

  const everyId = [parentId, siblingId, childId, grandchildId].sort();

  const parentView = await harness.json<ListValue>(["list"], {
    env: { HLAO_SESSION_ID: parentId },
  });
  assert.deepEqual(
    parentView.value.sessions.map((session) => session.id).sort(),
    everyId,
  );

  const childView = await harness.json<ListValue>(["list"], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.deepEqual(
    childView.value.sessions.map((session) => session.id).sort(),
    everyId,
  );

  // Siblings and ancestors are addressable: no scope filter.
  const parentRead = await harness.json<ReadValue>(["read", parentId], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.equal(parentRead.code, 0);
  assert.ok(parentRead.value.events.length > 0);

  const siblingRead = await harness.json<ReadValue>(["read", siblingId], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.equal(siblingRead.code, 0);
  assert.ok(siblingRead.value.events.length > 0);

  const siblingSend = await harness.json<{ queued: boolean }>(
    ["send", siblingId, "cross-tree"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(siblingSend.code, 0);

  const siblingWait = await harness.json<{ satisfied: boolean }>(
    ["wait", siblingId, "--until", "idle"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(siblingWait.code, 0);

  const siblingCancel = await harness.json<CancelValue>(["cancel", siblingId], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.equal(siblingCancel.code, 0);

  // A session can act on itself: the participant that can see its own
  // situation is never locked out of managing it.
  const selfCancel = await harness.json<CancelValue>(["cancel", childId], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.equal(selfCancel.code, 0);
  assert.equal(selfCancel.value.session.status, "idle");

  const operator = await harness.json<ListValue>(["list"]);
  assert.ok(operator.value.sessions.some((session) => session.id === siblingId));

  const closed = await harness.json<{ count: number; sessions: unknown[] }>([
    "close",
    parentId,
    "--tree",
  ]);
  assert.equal(closed.value.count, 3);

  const remaining = await harness.json<ListValue>(["list"]);
  assert.deepEqual(
    remaining.value.sessions.map((session) => session.id),
    [siblingId],
  );
});
