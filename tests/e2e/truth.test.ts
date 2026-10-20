import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pidAlive } from "../../src/lock.js";
import {
  Harness,
  waitFor,
  type DoctorValue,
  type JsonError,
  type SendValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

test("wait --until settled treats termination as completion in human mode", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "boom",
    "--env",
    "FAKE_MODE=crash",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  await harness.waitForSession(id, "failed");

  const json = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "settled",
    "--timeout",
    "5s",
  ]);
  assert.equal(json.code, 0);
  assert.equal(json.value.satisfied, true);
  assert.equal(json.value.reason, "exit");

  const human = await harness.run(
    ["wait", id, "--until", "settled", "--timeout", "5s"],
    { json: false },
  );
  assert.equal(human.code, 0);
  assert.match(human.stdout, /settled \(exit\)/);

  // The historical idle condition still reports a terminal session as
  // unsatisfied; only settled treats termination as completion.
  const idle = await harness.run(
    ["wait", id, "--until", "idle", "--timeout", "5s"],
    { json: false },
  );
  assert.equal(idle.code, 3);
});

test("wait --until idle names a permission stop instead of claiming idle", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "gate",
    "--env",
    "FAKE_MODE=permission",
    "--permission",
    "ask",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  const permission = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);
  assert.equal(permission.code, 0);

  const human = await harness.run(
    ["wait", id, "--until", "idle", "--timeout", "5s"],
    { json: false },
  );
  assert.equal(human.code, 0);
  assert.match(human.stdout, /settled \(permission\)/);
  assert.match(human.stdout, /permit .* --allow/);

  const json = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "5s",
  ]);
  assert.equal(json.code, 0);
  assert.equal(json.value.satisfied, true);
  assert.equal(json.value.reason, "permission");
});

test("list --cwd with no match still reports the instance counts", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const otherDir = join(harness.home, "other");
  mkdirSync(otherDir, { recursive: true });
  const first = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "one",
    "--cwd",
    harness.home,
    "--wait",
  ]);
  assert.equal(first.code, 0);
  const second = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "two",
    "--cwd",
    otherDir,
    "--wait",
  ]);
  assert.equal(second.code, 0);

  const noMatch = await harness.run(
    ["list", "--cwd", join(harness.home, "missing")],
    { json: false },
  );
  assert.equal(noMatch.code, 0);
  assert.match(noMatch.stdout, /no sessions match the filters/);
  assert.match(noMatch.stdout, /2 live · 0 retained · showing 0/);

  type CountedList = {
    sessions: { id: string }[];
    counts: { live: number; retained: number; total: number };
  };
  const json = await harness.json<CountedList>([
    "list",
    "--cwd",
    join(harness.home, "missing"),
  ]);
  assert.equal(json.code, 0);
  assert.deepEqual(json.value.sessions, []);
  assert.deepEqual(json.value.counts, { live: 2, retained: 0, total: 2 });

  const exact = await harness.json<CountedList>(["list", "--cwd", otherDir]);
  assert.equal(exact.code, 0);
  assert.deepEqual(
    exact.value.sessions.map((session) => session.id),
    [second.value.session.id],
  );

  const prefix = await harness.json<CountedList>([
    "list",
    "--cwd-prefix",
    harness.home,
  ]);
  assert.equal(prefix.code, 0);
  assert.equal(prefix.value.sessions.length, 2);
});

test("get human output carries the state its help promises", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "inspect",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const human = await harness.run(["get", id], { json: false });
  assert.equal(human.code, 0);
  for (const label of [
    "state",
    "policy",
    "config",
    "usage",
    "lineage",
    "pending",
    "exit",
    "cwd",
  ]) {
    assert.match(human.stdout, new RegExp(`^${label}\\s`, "m"), label);
  }
  assert.match(human.stdout, /model=sonnet/);
  assert.match(human.stdout, /created by operator/);

  const brief = await harness.run(["get", id, "--brief"], { json: false });
  assert.equal(brief.code, 0);
  assert.doesNotMatch(brief.stdout, /^config\s/m);
  assert.match(brief.stdout, new RegExp(id));
});

test("a supervisor crash is announced and recorded", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "before crash",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const status = await harness.json<{ pid: number }>(["status"]);
  assert.equal(status.code, 0);
  const oldPid = status.value.pid;
  process.kill(oldPid, "SIGKILL");
  await waitFor(() => !pidAlive(oldPid), "the old supervisor to exit");

  const listed = await harness.run(["list"], { json: false });
  assert.equal(listed.code, 0);
  assert.match(
    listed.stderr,
    new RegExp(
      `previous supervisor \\(pid ${oldPid}\\) did not shut down cleanly`,
    ),
  );
  assert.match(listed.stdout, /0 live/);

  const after = await harness.json<{
    running: boolean;
    lastCrash?: { pid: number };
  }>(["status"]);
  assert.equal(after.code, 0);
  assert.equal(after.value.lastCrash?.pid, oldPid);

  const doctor = await harness.json<DoctorValue>(["doctor"]);
  assert.ok(
    doctor.value.checks.some((check) => check.name === "last crash"),
    "doctor should report the crash marker",
  );
});

test("a busy session cannot wait on its own queued message", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hold",
    "--env",
    "FAKE_MODE=never",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  await harness.waitForSession(id, "busy");

  const rejected = await harness.json<JsonError>(
    ["send", "--self", "again", "--wait", "--timeout", "2s"],
    { env: { HLAO_SESSION_ID: id } },
  );
  assert.equal(rejected.code, 1);
  assert.equal(rejected.value.error.code, "bad_request");
  assert.match(rejected.value.error.message, /without --wait/);

  const deferred = await harness.json<SendValue>(["send", "--self", "again"], {
    env: { HLAO_SESSION_ID: id },
  });
  assert.equal(deferred.code, 0);
  assert.equal(deferred.value.queued, true);
  await harness.json(["cancel", id]);
});

test("a sibling prompt is attributed in the human transcript", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "parent",
    "--wait",
    "--no-skill",
  ]);
  assert.equal(parent.code, 0);
  const child = await harness.json<SpawnValue>(
    ["spawn", "fake", "child", "--wait", "--no-skill"],
    { env: { HLAO_SESSION_ID: parent.value.session.id } },
  );
  assert.equal(child.code, 0);
  const childId = child.value.session.id;

  const sent = await harness.json<SendValue>(["send", childId, "from sibling"], {
    env: { HLAO_SESSION_ID: parent.value.session.id },
  });
  assert.equal(sent.code, 0);

  const human = await harness.run(["read", childId, "--since", "0"], {
    json: false,
  });
  assert.equal(human.code, 0);
  assert.match(
    human.stdout,
    new RegExp(`from ${parent.value.session.id} \\(msg-\\w+\\) › from sibling`),
  );
});
