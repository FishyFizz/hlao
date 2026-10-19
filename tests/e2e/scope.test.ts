import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type CancelValue,
  type JsonError,
  type ListValue,
  type SpawnValue,
} from "./harness.js";

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

test("self-and-descendants scope is enforced and the tree closes together", async (t) => {
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

  const parentView = await harness.json<ListValue>(["list"], {
    env: { HLAO_SESSION_ID: parentId },
  });
  assert.equal(parentView.value.scope, "session");
  assert.deepEqual(
    parentView.value.sessions.map((session) => session.id).sort(),
    [parentId, childId, grandchild.value.session.id].sort(),
  );

  const childView = await harness.json<ListValue>(["list"], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.deepEqual(
    childView.value.sessions.map((session) => session.id).sort(),
    [childId, grandchild.value.session.id].sort(),
  );
  assert.ok(!childView.value.sessions.some((session) => session.id === siblingId));

  const forbidden = await harness.json<JsonError>(
    ["read", parentId],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(forbidden.code, 1);
  assert.equal(forbidden.value.error.code, "forbidden");

  const siblingRead = await harness.json<JsonError>(
    ["read", siblingId],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(siblingRead.value.error.code, "forbidden");

  // A session can act on itself: this is the cron fix — the participant that
  // can see its own situation is never locked out of managing it.
  const selfCancel = await harness.json<CancelValue>(["cancel", childId], {
    env: { HLAO_SESSION_ID: childId },
  });
  assert.equal(selfCancel.code, 0);
  assert.equal(selfCancel.value.session.status, "idle");

  const operator = await harness.json<ListValue>(["list"]);
  assert.equal(operator.value.scope, "operator");
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
