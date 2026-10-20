import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { readLock } from "../../src/lock.js";
import { Harness, type ReadValue, type SpawnValue } from "./harness.js";

test("the skill is shipped, injected once, and can be suppressed", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const skill = await harness.json<{
    name: string;
    version: string;
    path: string;
    packagedPath: string;
    text: string;
  }>(["skill"]);
  assert.equal(skill.code, 0);
  assert.equal(skill.value.name, "hlao");
  assert.match(skill.value.text, /The prompt is the contract/);
  for (const line of skill.value.text.split("\n")) {
    if (/^\s*hlao send --self/.test(line)) {
      assert.doesNotMatch(line, /--wait/, "the worker loop must not self-wait");
    }
  }
  assert.ok(existsSync(skill.value.path));
  assert.equal(readFileSync(skill.value.path, "utf8"), skill.value.text);

  const path = await harness.run(["skill", "--path"], { json: false });
  assert.equal(path.code, 0);
  assert.equal(path.stdout.trim(), skill.value.path);

  const pathWord = await harness.run(["skill", "path"], { json: false });
  assert.equal(pathWord.code, 0);
  assert.equal(pathWord.stdout.trim(), skill.value.path);

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const first = spawned.value.firstTurn?.text ?? "";
  assert.match(first, /HLAO skill:/);
  assert.match(first, /hello/);
  // The pointer ends with a blank line, so a block-concatenating adapter does
  // not glue it onto the operator's first words.
  assert.match(first, /tools\.\n\nhello/);

  // The injection is recorded on the prompt that carried it.
  const history = await harness.json<ReadValue>([
    "read",
    spawned.value.session.id,
    "--since",
    "0",
  ]);
  const injected = history.value.events.find(
    (event) => event.type === "prompt.sent",
  )?.data.injected;
  assert.deepEqual(injected, {
    skill: skill.value.version,
    path: skill.value.path,
    blocks: 2,
  });

  // The pointer belongs to the first prompt only.
  const again = await harness.json<{ text?: string }>([
    "send",
    spawned.value.session.id,
    "second",
    "--wait",
  ]);
  assert.doesNotMatch(again.value.text ?? "", /HLAO skill:/);

  const suppressed = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "quiet",
    "--wait",
    "--no-skill",
  ]);
  assert.doesNotMatch(suppressed.value.firstTurn?.text ?? "", /HLAO skill:/);
  const suppressedHistory = await harness.json<ReadValue>([
    "read",
    suppressed.value.session.id,
    "--since",
    "0",
  ]);
  assert.equal(
    suppressedHistory.value.events.find(
      (event) => event.type === "prompt.sent",
    )?.data.injected,
    undefined,
  );

  const fromEnv = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "report",
    "--wait",
    "--env",
    "FAKE_MODE=env",
  ]);
  const envText = fromEnv.value.firstTurn?.text ?? "";
  const envJson = JSON.parse(
    envText.slice(envText.indexOf("{")),
  ) as { skill: string | null; skillVersion: string | null };
  assert.equal(envJson.skill, skill.value.path);
  assert.equal(envJson.skillVersion, skill.value.version);
});

test("whoami reports the live name and never starts a supervisor", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--name",
    "old",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  const renamed = await harness.json(["rename", id, "newname"]);
  assert.equal(renamed.code, 0);

  const env = { HLAO_SESSION_ID: id, HLAO_NAME: "old" };
  const live = await harness.json<{
    live: boolean;
    liveName: string | null;
    name: string | null;
    nameStale: boolean;
  }>(["whoami"], { env });
  assert.equal(live.code, 0);
  assert.equal(live.value.live, true);
  assert.equal(live.value.liveName, "newname");
  assert.equal(live.value.name, "old");
  assert.equal(live.value.nameStale, true);

  const human = await harness.run(["whoami"], { json: false, env });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /live name is "newname"/);

  // A stale id must not autostart a supervisor or create a lock.
  const fresh = new Harness();
  t.after(() => fresh.cleanup());
  const stale = await fresh.json<{ live: boolean }>(["whoami"], {
    env: { HLAO_SESSION_ID: "zzzzzz" },
  });
  assert.equal(stale.code, 0);
  assert.equal(stale.value.live, false);
  assert.equal(readLock(fresh.home), null);
});
