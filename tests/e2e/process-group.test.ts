import assert from "node:assert/strict";
import { test } from "node:test";
import { pidAlive } from "../../src/lock.js";
import {
  Harness,
  waitFor,
  type ReadValue,
  type SpawnValue,
} from "./harness.js";

const posix = process.platform !== "win32";

async function waitForChildPid(harness: Harness, id: string): Promise<number> {
  let pid: number | null = null;
  await waitFor(async () => {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    for (const event of read.value.events) {
      const text = event.data.text;
      if (typeof text !== "string") continue;
      const match = /CHILD_PID: (\d+)/.exec(text);
      if (match) {
        pid = Number(match[1]);
        return true;
      }
    }
    return false;
  }, `session ${id} reporting a child pid`);
  return pid!;
}

async function spawnWithChild(harness: Harness): Promise<{ id: string; pid: number }> {
  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "go",
    "--env",
    "FAKE_MODE=spawn-child",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  const pid = await waitForChildPid(harness, id);
  return { id, pid };
}

test("force close kills the adapter's process group", { skip: !posix }, async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const { id, pid } = await spawnWithChild(harness);
  assert.equal(pidAlive(pid), true);

  const closed = await harness.json<{ killed: boolean }>(["close", id, "--force"]);
  assert.equal(closed.code, 0);
  assert.equal(closed.value.killed, true);

  await waitFor(() => !pidAlive(pid), `child ${pid} exiting`);
});

test("graceful close also takes the process group", { skip: !posix }, async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const { id, pid } = await spawnWithChild(harness);
  assert.equal(pidAlive(pid), true);

  const closed = await harness.json<{ killed: boolean }>(["close", id]);
  assert.equal(closed.code, 0);

  await waitFor(() => !pidAlive(pid), `child ${pid} exiting`);
});
