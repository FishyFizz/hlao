import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Harness, type ReadValue, type SpawnValue } from "./harness.js";

test("verbose tool payloads are omitted by default and rendered on request", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "verbose payload",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const plain = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  const call = plain.value.events.find((event) => event.type === "tool.call");
  assert.ok(call);
  assert.equal(call.data.rawInput, undefined);

  const raw = await harness.json<ReadValue>([
    "read",
    id,
    "--since",
    "0",
    "--raw",
  ]);
  const rawCall = raw.value.events.find((event) => event.type === "tool.call");
  assert.deepEqual(rawCall?.data.rawInput, { prompt: "verbose payload" });

  const quiet = await harness.run(["read", id, "--since", "0"], {
    json: false,
  });
  assert.doesNotMatch(quiet.stdout, /"prompt": "verbose payload"/);

  const verbose = await harness.run(
    ["read", id, "--since", "0", "--verbose"],
    { json: false },
  );
  assert.match(verbose.stdout, /"prompt": "verbose payload"/);
  assert.match(verbose.stdout, /"ok": true/);
});

test("mode errors list the advertised ids and names", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "modes",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const failed = await harness.run(
    ["mode", spawned.value.session.id, "nonsense"],
    { json: false },
  );
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /mode "nonsense" is not available/);
  assert.match(failed.stderr, /default \(Manual\)/);
  assert.match(failed.stderr, /auto \(Auto\)/);
  assert.match(failed.stderr, /bypassPermissions \(Bypass\)/);
});

test("not_found suggests hlao list", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const missing = await harness.run(["read", "nosuch"], { json: false });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no session matching "nosuch"/);
  assert.match(missing.stderr, /run "hlao list"/);
});

test("agents shows the config file that defined a backend", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const json = await harness.json<{
    agents: { name: string; configPath?: string }[];
  }>(["agents"]);
  const fake = json.value.agents.find((agent) => agent.name === "fake");
  assert.equal(
    resolve(fake?.configPath ?? ""),
    resolve(join(harness.home, "config.json")),
  );

  const human = await harness.run(["agents"], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /CONFIG/);
  const row = human.stdout
    .split("\n")
    .find((line) => line.includes("config.json"))!;
  assert.match(row, /…/);
  assert.match(row, /config\.json/);
});

test("down warns that live sessions and in-memory history are lost", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "doomed",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const down = await harness.run(["down"], { json: false });
  assert.equal(down.code, 0);
  assert.match(down.stderr, /discards their in-memory history/);
  assert.match(down.stdout, /supervisor stopped \(1 session closed\)/);
});
