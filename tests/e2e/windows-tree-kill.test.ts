import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pidAlive } from "../../src/lock.js";
import { Harness, type SpawnValue } from "./harness.js";

test(
  "close --force terminates adapter descendants on Windows",
  { skip: process.platform !== "win32" },
  async (t) => {
    const harness = new Harness();
    let childPid: number | null = null;

    t.after(async () => {
      if (childPid !== null && pidAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await harness.cleanup();
    });

    const pidFile = join(harness.home, "child.pid");
    const spawned = await harness.json<SpawnValue>([
      "spawn",
      "fake",
      "--env",
      "FAKE_MODE=spawn-child",
      "--env",
      `FAKE_CHILD_PID_FILE=${pidFile}`,
    ]);
    assert.equal(spawned.code, 0);
    const id = spawned.value.session.id;
    await harness.json(["send", id, "go"]);

    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(pidFile), "the adapter did not report its child pid");
    childPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pidAlive(childPid));

    const closed = await harness.json(["close", id, "--force"]);
    assert.equal(closed.code, 0);

    const gone = await waitFor(() => !pidAlive(childPid!), 5_000);
    assert.equal(gone, true, `child ${childPid} survived close --force`);
  },
);

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}
