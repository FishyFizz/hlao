import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type ListValue,
  type SendValue,
  type SpawnValue,
} from "./harness.js";

test("list --mine scopes to the caller's root subtree", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "parent",
    "--wait",
  ]);
  assert.equal(parent.code, 0);
  const parentId = parent.value.session.id;

  const child = await harness.json<SpawnValue>(["spawn", "fake", "child", "--wait"], {
    env: { HLAO_SESSION_ID: parentId },
  });
  assert.equal(child.code, 0);
  const childId = child.value.session.id;

  const unrelated = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "unrelated",
    "--wait",
  ]);
  assert.equal(unrelated.code, 0);

  const mine = await harness.json<ListValue>(["list", "--mine"], {
    env: { HLAO_SESSION_ID: parentId },
  });
  assert.equal(mine.code, 0);
  const ids = mine.value.sessions.map((session) => session.id).sort();
  assert.deepEqual(ids, [parentId, childId].sort());

  const byRoot = await harness.json<ListValue>(["list", "--mine"], {
    env: { HLAO_ROOT_ID: parent.value.session.rootId },
  });
  assert.equal(byRoot.code, 0);
  assert.deepEqual(
    byRoot.value.sessions.map((session) => session.id).sort(),
    ids,
  );

  const missing = await harness.json<JsonError>(["list", "--mine"]);
  assert.equal(missing.code, 1);
  assert.match(missing.value.error.message, /HLAO_SESSION_ID or HLAO_ROOT_ID/);
});

test("a timed-out wait reports partial text", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "go",
    "--wait",
    "--timeout",
    "200ms",
    "--env",
    "FAKE_MODE=slow",
  ]);
  assert.equal(spawned.code, 2);
  assert.equal(spawned.value.firstTurn?.timedOut, true);
  assert.equal(spawned.value.firstTurn?.text, "working…");
  const id = spawned.value.session.id;

  const human = await harness.run(
    ["spawn", "fake", "go", "--wait", "--timeout", "200ms", "--env", "FAKE_MODE=slow"],
    { json: false },
  );
  assert.equal(human.code, 2);
  assert.match(human.stdout, /working…/);
  assert.match(human.stdout, /the first turn is still running/);

  const settled = await harness.json(["wait", id, "--until", "settled", "--timeout", "10s"]);
  assert.equal(settled.code, 0);

  const sent = await harness.json<SendValue>([
    "send",
    id,
    "again",
    "--wait",
    "--timeout",
    "200ms",
  ]);
  assert.equal(sent.code, 2);
  assert.equal(sent.value.outcome, "timed_out");
  assert.equal(sent.value.text, "working…");
});

test("a failed first turn names the session for recovery", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const failed = await harness.run(
    ["spawn", "fake", "go", "--wait", "--env", "FAKE_MODE=crash"],
    { json: false },
  );
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /session: \w{6}/);
  assert.match(failed.stderr, /recover: hlao close \w{6}/);
  assert.match(failed.stderr, /inspect: hlao read \w{6} --json/);
});
