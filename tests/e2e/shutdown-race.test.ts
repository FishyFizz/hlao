import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type ListValue, type RunResult } from "./harness.js";

test("shutdown during a slow spawn does not leave a session behind", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawning = harness.run([
    "spawn",
    "fake",
    "--env",
    "FAKE_STARTUP_DELAY_MS=1500",
  ]);

  await new Promise((resolve) => setTimeout(resolve, 250));
  const down = await harness.run(["down", "--force"], { timeoutMs: 20_000 });
  assert.equal(down.code, 0);

  const spawnResult: RunResult = await spawning;
  assert.notEqual(spawnResult.code, 0, "the spawn must not report success during shutdown");

  // A fresh supervisor proves the old one is gone and nothing survived it.
  const list = await harness.json<ListValue>(["list"]);
  assert.equal(list.code, 0);
  assert.equal(list.value.sessions.length, 0);
});
