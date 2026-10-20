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

test("down reports retained history and supports --dry-run", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "--wait"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  const closed = await harness.json(["close", id]);
  assert.equal(closed.code, 0);

  const dry = await harness.json<{
    dryRun: boolean;
    live: number;
    retained: number;
  }>(["down", "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.live, 0);
  assert.equal(dry.value.retained, 1);

  // A dry run must not stop the supervisor or discard the retained log.
  const listed = await harness.json<ListValue>(["list", "--all"]);
  assert.equal(listed.code, 0);
  assert.ok(listed.value.sessions.some((session) => session.id === id));

  const human = await harness.run(["down"], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stderr, /retained session history/);
  assert.match(human.stdout, /1 retained history discarded/);
});
