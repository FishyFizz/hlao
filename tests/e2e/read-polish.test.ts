import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  FAKE_AGENT,
  Harness,
  type ReadValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function writeConfig(harness: Harness, extra: Record<string, unknown>): void {
  writeFileSync(
    join(harness.home, "config.json"),
    JSON.stringify(
      {
        ...extra,
        backends: {
          fake: {
            command: process.execPath,
            args: [FAKE_AGENT],
            description: "scripted ACP test agent",
          },
        },
      },
      null,
      2,
    ),
  );
}

test("a truncated tail is reported in JSON and human output", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  writeConfig(harness, { maxEventsPerSession: 3 });

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "chunks",
    "--env",
    "FAKE_MODE=chunks",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const read = await harness.json<ReadValue>(["read", id]);
  assert.equal(read.code, 0);
  assert.equal(read.value.truncated, true);
  assert.ok(read.value.earliestRetainedSeq > 1);
  assert.ok(read.value.events.length > 0);
  assert.ok(read.value.events.length <= 3);

  const human = await harness.run(["read", id], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /history starts at #\d+/);
  assert.match(human.stdout, /\d+ earlier events were evicted/);
});

test("human read shows short timestamps and --timestamps shows ISO", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "clock",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const short = await harness.run(["read", id], { json: false });
  assert.equal(short.code, 0);
  assert.match(short.stdout, /#\d+\s+\d{2}:\d{2}:\d{2}\s/);

  const full = await harness.run(["read", id, "--timestamps"], {
    json: false,
  });
  assert.equal(full.code, 0);
  assert.match(full.stdout, /#\d+\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("a visible pending permission is summarized once in the header", async (t) => {
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

  const waited = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "permission",
    "--timeout",
    "10s",
  ]);
  assert.equal(waited.code, 0);
  assert.equal(waited.value.reason, "permission");

  const read = await harness.run(["read", id], { json: false });
  assert.equal(read.code, 0);
  assert.equal(occurrences(read.stdout, "permission needed"), 1);
  assert.equal(occurrences(read.stdout, "pending permission:"), 1);
  assert.match(read.stdout, /Run the build/);
});
