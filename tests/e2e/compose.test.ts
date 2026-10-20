import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  waitFor,
  type ListValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

async function spawn(
  harness: Harness,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await harness.json<SpawnValue>(args, env ? { env } : {});
  assert.equal(result.code, 0, JSON.stringify(result.value));
  return result.value.session.id;
}

async function waitForPending(harness: Harness, count: number): Promise<void> {
  await waitFor(
    async () =>
      (await harness.json<ListValue>(["list", "--pending"])).value.sessions
        .length >= count,
    `${count} pending permissions`,
  );
}

test("wait and get select whole sets without collecting ids", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await spawn(harness, [
    "spawn",
    "fake",
    "parent",
    "--name",
    "root",
    "--wait",
  ]);
  const child = await spawn(
    harness,
    ["spawn", "fake", "child", "--wait"],
    { HLAO_SESSION_ID: parent },
  );

  const byRoot = await harness.json<WaitValue>([
    "wait",
    "--root",
    parent,
    "--all",
    "--until",
    "settled",
    "--timeout",
    "15s",
  ]);
  assert.equal(byRoot.code, 0);
  assert.ok(byRoot.value.results.length >= 2);

  const byStatus = await harness.json<WaitValue>([
    "wait",
    "--status",
    "idle",
    "--all",
    "--until",
    "settled",
    "--timeout",
    "10s",
  ]);
  assert.equal(byStatus.code, 0);

  const byIdle = await harness.json<WaitValue>([
    "wait",
    "--idle",
    "0",
    "--all",
    "--until",
    "settled",
    "--timeout",
    "10s",
  ]);
  assert.equal(byIdle.code, 0);

  const got = await harness.json<{
    session: { id: string; settled: boolean };
  }>(["get", child]);
  assert.equal(got.code, 0);
  assert.equal(got.value.session.id, child);
  assert.equal(got.value.session.settled, true);

  const human = await harness.run(["get", child], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, new RegExp(child));
  assert.match(human.stdout, /idle/);
});

test("cancel --root --wait stops a whole set and confirms settlement", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await spawn(harness, ["spawn", "fake", "--wait"]);
  const env = { HLAO_SESSION_ID: parent };
  const one = await spawn(
    harness,
    [
      "spawn",
      "fake",
      "--env",
      "FAKE_MODE=slow",
      "--env",
      "FAKE_DELAY_MS=5000",
    ],
    env,
  );
  const two = await spawn(
    harness,
    [
      "spawn",
      "fake",
      "--env",
      "FAKE_MODE=slow",
      "--env",
      "FAKE_DELAY_MS=5000",
    ],
    env,
  );
  await harness.json(["send", one, "go"]);
  await harness.json(["send", two, "go"]);

  await waitFor(async () => {
    const listed = await harness.json<ListValue>(["list"]);
    const busy = listed.value.sessions.filter(
      (session) => session.status === "busy",
    );
    return busy.length >= 2;
  }, "two busy sessions");

  const cancelled = await harness.json<{
    count: number;
    waited?: { satisfied: boolean };
  }>(["cancel", "--root", parent, "--wait", "--timeout", "10s"]);
  assert.equal(cancelled.code, 0);
  assert.ok(cancelled.value.count >= 2);
  assert.equal(cancelled.value.waited?.satisfied, true);

  const after = await harness.json<ListValue>(["list"]);
  assert.ok(
    after.value.sessions.every((session) => session.status !== "busy"),
    JSON.stringify(after.value.sessions),
  );
});

test("permit --all-pending answers every parked request", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  await spawn(harness, [
    "spawn",
    "fake",
    "ask one",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ]);
  await spawn(harness, [
    "spawn",
    "fake",
    "ask two",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ]);
  await waitForPending(harness, 2);

  const permitted = await harness.json<{ count: number }>([
    "permit",
    "--all-pending",
    "--allow",
  ]);
  assert.equal(permitted.code, 0);
  assert.equal(permitted.value.count, 2);

  const pending = await harness.json<ListValue>(["list", "--pending"]);
  assert.deepEqual(pending.value.sessions, []);
});

test("policy selectors apply to a whole tree", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await spawn(harness, ["spawn", "fake", "--wait"]);
  const child = await spawn(
    harness,
    ["spawn", "fake", "--wait"],
    { HLAO_SESSION_ID: parent },
  );

  const changed = await harness.json<{
    count: number;
    sessions: { id: string; permissionPolicy: string }[];
  }>(["policy", "--root", parent, "ask"]);
  assert.equal(changed.code, 0);
  assert.equal(changed.value.count, 2);
  assert.deepEqual(
    new Set(changed.value.sessions.map((session) => session.id)),
    new Set([parent, child]),
  );
  assert.ok(
    changed.value.sessions.every(
      (session) => session.permissionPolicy === "ask",
    ),
  );
});

test("find searches across sessions with a bounded loop", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const id = await spawn(harness, [
    "spawn",
    "fake",
    "the needle is here",
    "--wait",
  ]);

  const found = await harness.json<{
    count: number;
    matches: { sessionId: string; event: { type: string } }[];
  }>(["find", "needle"]);
  assert.equal(found.code, 0);
  assert.ok(found.value.count >= 1);
  assert.ok(found.value.matches.some((match) => match.sessionId === id));

  const typed = await harness.json<{ count: number }>([
    "find",
    "needle",
    "--type",
    "agent.message",
  ]);
  assert.equal(typed.code, 0);
  assert.ok(typed.value.count >= 1);

  const none = await harness.json<{ count: number }>([
    "find",
    "zzz-not-there",
  ]);
  assert.equal(none.code, 0);
  assert.equal(none.value.count, 0);

  const human = await harness.run(["find", "zzz-not-there"], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /no matches/);
});
