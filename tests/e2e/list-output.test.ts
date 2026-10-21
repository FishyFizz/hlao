import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

test("list --compact drops static provider options from JSON", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "compact", "--wait"]);
  assert.equal(spawned.code, 0);

  const full = await harness.json<{ sessions: Record<string, unknown>[] }>([
    "list",
  ]);
  assert.equal(full.code, 0);
  assert.ok("modes" in full.value.sessions[0]!);
  assert.ok("configOptions" in full.value.sessions[0]!);

  const compact = await harness.json<{ sessions: Record<string, unknown>[] }>([
    "list",
    "--compact",
  ]);
  assert.equal(compact.code, 0);
  assert.equal("modes" in compact.value.sessions[0]!, false);
  assert.equal("configOptions" in compact.value.sessions[0]!, false);
  assert.ok("usage" in compact.value.sessions[0]!);

  const invalid = await harness.run(["list", "--compact"], { json: false });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr + invalid.stdout, /requires --json/);
});

test("list --fields and --no-cwd control the human columns", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "columns", "--wait"]);
  assert.equal(spawned.code, 0);

  const fields = await harness.run(["list", "--fields", "id,status"], {
    json: false,
  });
  assert.equal(fields.code, 0);
  const [header] = fields.stdout.split("\n");
  assert.equal(header!.trim(), "ID      STATUS");

  const noCwd = await harness.run(["list", "--no-cwd"], { json: false });
  assert.equal(noCwd.code, 0);
  assert.doesNotMatch(noCwd.stdout, /\bCWD\b/);

  const unknown = await harness.run(["list", "--fields", "bogus"], {
    json: false,
  });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr + unknown.stdout, /unknown --fields bogus/);

  const jsonFields = await harness.run(["list", "--fields", "id"]);
  assert.equal(jsonFields.code, 1);
  assert.match(jsonFields.stdout, /use --compact for JSON/);
});
