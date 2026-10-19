import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type SpawnValue,
} from "./harness.js";

type ModesValue = {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
};
type SetModeValue = { session: SpawnValue["session"] };

test("provider modes are advertised, switchable, and validated", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--mode",
    "auto",
  ]);
  assert.equal(spawned.code, 0, JSON.stringify(spawned.value));
  assert.equal(spawned.value.session.modes?.currentModeId, "auto");
  const id = spawned.value.session.id;

  const read = await harness.json<ModesValue>(["mode", id]);
  assert.equal(read.code, 0);
  assert.equal(read.value.currentModeId, "auto");
  assert.deepEqual(
    read.value.availableModes.map((mode) => mode.id),
    ["default", "auto", "bypassPermissions"],
  );

  const changed = await harness.json<SetModeValue>(["mode", id, "default"]);
  assert.equal(changed.code, 0);
  assert.equal(changed.value.session.modes?.currentModeId, "default");

  const bad = await harness.json<JsonError>(["mode", id, "not-a-mode"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.value.error.code, "bad_option");

  const after = await harness.json<ModesValue>(["mode", id]);
  assert.equal(after.value.currentModeId, "default");
});
