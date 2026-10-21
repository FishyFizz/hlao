import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type GetValue, type ListValue, type SpawnValue } from "./harness.js";

test("firstPrompt is the display fallback for an unnamed, untitled session", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "audit the build log",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  assert.equal(spawned.value.session.firstPrompt, "audit the build log");

  const list = await harness.json<ListValue>(["list"]);
  const view = list.value.sessions.find((session) => session.id === id);
  assert.ok(view);
  assert.equal(view!.name, null);
  assert.equal(view!.title ?? null, null);
  assert.equal(view!.firstPrompt, "audit the build log");

  const got = await harness.json<GetValue>(["get", id]);
  assert.equal(got.value.session.firstPrompt, "audit the build log");

  const human = await harness.run(["list"], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /audit the build log/);
});

test("a session with no prompt has no firstPrompt until one is sent", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  assert.equal(spawned.value.session.firstPrompt ?? null, null);

  const sent = await harness.json(["send", id, "follow-up instruction", "--wait"]);
  assert.equal(sent.code, 0);

  const got = await harness.json<GetValue>(["get", id]);
  assert.equal(got.value.session.firstPrompt, "follow-up instruction");
});
