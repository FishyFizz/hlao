import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type ReadValue, type SpawnValue } from "./harness.js";

const posix = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForChildPid(harness: Harness, id: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
    for (const event of read.value.events) {
      const text = event.data.text;
      if (typeof text !== "string") continue;
      const match = /CHILD_PID: (\d+)/.exec(text);
      if (match) return Number(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session ${id} never reported a child pid`);
}

async function waitForGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
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
  assert.equal(alive(pid), true);

  const closed = await harness.json<{ killed: boolean }>(["close", id, "--force"]);
  assert.equal(closed.code, 0);
  assert.equal(closed.value.killed, true);

  assert.equal(await waitForGone(pid), true, `child ${pid} outlived the adapter`);
});

test("graceful close also takes the process group", { skip: !posix }, async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const { id, pid } = await spawnWithChild(harness);
  assert.equal(alive(pid), true);

  const closed = await harness.json<{ killed: boolean }>(["close", id]);
  assert.equal(closed.code, 0);

  assert.equal(await waitForGone(pid), true, `child ${pid} outlived the adapter`);
});
