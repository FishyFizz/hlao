import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

interface UsageRowValue {
  sessionId: string;
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
}

interface UsageValue {
  group: string;
  rows: UsageRowValue[];
  totals: { cost: { amount: number; currency: string } }[];
}

interface GroupRowValue {
  key: string;
  sessions: number;
  cost: string;
}

test("usage projects the latest snapshot and totals cost", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "usage",
    "--env",
    "FAKE_MODE=usage",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const usage = await harness.json<UsageValue>(["usage"]);
  assert.equal(usage.code, 0);
  const row = usage.value.rows.find((entry) => entry.sessionId === id);
  assert.ok(row, "the spawned session reports usage");
  assert.equal(row!.used, 1_450);
  assert.equal(row!.size, 200_000);
  assert.deepEqual(row!.cost, { amount: 250, currency: "USD" });
  assert.deepEqual(usage.value.totals, [
    { cost: { amount: 250, currency: "USD" } },
  ]);
});

test("usage groups by root and model without summing tokens", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "usage-root",
    "--env",
    "FAKE_MODE=usage",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const root = await harness.json<{ rows: GroupRowValue[] }>([
    "usage",
    "--group",
    "root",
  ]);
  assert.equal(root.code, 0);
  assert.equal(root.value.rows.length, 1);
  assert.equal(root.value.rows[0]!.sessions, 1);
  assert.match(root.value.rows[0]!.cost, /2\.50 USD/);

  const model = await harness.json<{ rows: GroupRowValue[] }>([
    "usage",
    "--group",
    "model",
  ]);
  assert.equal(model.code, 0);
  assert.equal(model.value.rows.length, 1);
  assert.equal(model.value.rows[0]!.sessions, 1);
});

test("usage time windows read the latest usage event in the window", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "usage-window",
    "--env",
    "FAKE_MODE=usage",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const recent = await harness.json<UsageValue>(["usage", "--since", "1h"]);
  assert.equal(recent.code, 0);
  const row = recent.value.rows.find((entry) => entry.sessionId === id);
  assert.ok(row);
  assert.equal(row!.used, 1_450);

  const old = await harness.json<UsageValue>(["usage", "--until", "1h"]);
  assert.equal(old.code, 0);
  assert.equal(old.value.rows.length, 0);
});
