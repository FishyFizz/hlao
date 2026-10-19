import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readLock } from "../../src/lock.js";
import {
  Harness,
  type JsonError,
  type ListValue,
  type SpawnValue,
} from "./harness.js";

test("down --force removes a stale lock without killing an unrelated pid", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hlao-absent-${Date.now().toString(36)}`
      : join(harness.home, "absent.sock");
  writeFileSync(
    join(harness.home, "supervisor.json"),
    JSON.stringify({
      pid: process.pid,
      token: "stale-token",
      endpoint,
      protocolVersion: 1,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      version: "0.1.0",
      state: "running",
    }),
  );

  const result = await harness.json<{
    stopped: boolean;
    staleLockRemoved: boolean;
    pidLeftRunning: boolean;
  }>(["down", "--force"]);

  assert.equal(result.code, 0);
  assert.equal(result.value.stopped, false);
  assert.equal(result.value.staleLockRemoved, true);
  assert.equal(result.value.pidLeftRunning, true);
  assert.equal(readLock(harness.home), null);
  // The test runner is still alive; that is the assertion that it was not killed.
});

test("down --force from a session is refused", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake"]);
  const id = spawned.value.session.id;

  const refused = await harness.json<JsonError>(["down", "--force"], {
    env: { HLAO_SESSION_ID: id },
  });
  assert.equal(refused.code, 1);
  assert.equal(refused.value.error.code, "operator_only");

  const listed = await harness.json<ListValue>(["list"]);
  assert.equal(listed.code, 0);
  assert.ok(listed.value.sessions.some((session) => session.id === id));
});
