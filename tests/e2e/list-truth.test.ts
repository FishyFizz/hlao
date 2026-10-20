import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

test("list reports live and retained counts and resolves roots against the full table", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--name",
    "root",
    "--wait",
  ]);
  assert.equal(parent.code, 0);
  const parentId = parent.value.session.id;

  const child = await harness.json<SpawnValue>(["spawn", "fake", "--wait"], {
    env: { HLAO_SESSION_ID: parentId },
  });
  assert.equal(child.code, 0);
  const childId = child.value.session.id;

  const live = await harness.run(["list"], { json: false });
  assert.equal(live.code, 0);
  assert.match(live.stdout, /2 live · 0 retained/);

  // A closed root stays retrievable for lineage and is counted as retained,
  // even though the default view hides it.
  await harness.json(["close", parentId]);
  const after = await harness.run(["list"], { json: false });
  assert.equal(after.code, 0);
  assert.match(after.stdout, /1 live · 1 retained/);
  assert.doesNotMatch(after.stdout, new RegExp(parentId));
  assert.match(after.stdout, new RegExp(childId));

  const byRoot = await harness.json<{
    sessions: { id: string }[];
    counts: { live: number; retained: number; total: number };
  }>(["list", "--root", parentId]);
  assert.equal(byRoot.code, 0);
  assert.ok(byRoot.value.sessions.some((session) => session.id === childId));
  assert.deepEqual(byRoot.value.counts, { live: 1, retained: 1, total: 2 });

  // --tree implies --all for lineage, so the retained root is rendered.
  const tree = await harness.run(["list", "--tree"], { json: false });
  assert.equal(tree.code, 0);
  assert.match(tree.stdout, new RegExp(parentId));
  assert.match(tree.stdout, /ACTIVITY/);
  assert.match(tree.stdout, /1 live · 1 retained/);
});

test("list --wide shows created time and the last event", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const wide = await harness.run(["list", "--wide"], { json: false });
  assert.equal(wide.code, 0);
  assert.match(wide.stdout, /CREATED\s+EVENT/);
  assert.match(wide.stdout, /turn\.ended|agent\.message|session\.initialized/);
});

test("list filters report how many of the instance are shown", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  await harness.json<SpawnValue>(["spawn", "fake", "--name", "alpha", "--wait"]);
  await harness.json<SpawnValue>(["spawn", "fake", "--name", "beta", "--wait"]);

  const filtered = await harness.run(["list", "--name", "alpha"], {
    json: false,
  });
  assert.equal(filtered.code, 0);
  assert.match(filtered.stdout, /2 live · 0 retained · showing 1/);
});
