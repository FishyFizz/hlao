import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type ReadValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

test("an adapter crash fails the session, the prompt, and wait", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--env",
    "FAKE_MODE=crash",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const sent = await harness.json<JsonError>(["send", id, "go", "--wait", "--timeout", "10s"]);
  assert.equal(sent.code, 1);
  assert.equal(sent.value.error.code, "session_failed");

  const exited = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "exit",
    "--timeout",
    "10s",
  ]);
  assert.equal(exited.code, 0);
  assert.equal(exited.value.satisfied, true);
  assert.equal(exited.value.reason, "exit");
  assert.equal(exited.value.session.status, "failed");

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.ok(
    read.value.events.some((event) => event.type === "session.failed"),
  );

  const again = await harness.json<JsonError>(["send", id, "again"]);
  assert.equal(again.value.error.code, "session_closed");
});
