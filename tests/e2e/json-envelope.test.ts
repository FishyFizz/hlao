import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

interface Envelope<T = unknown> {
  ok: boolean;
  command: string;
  result?: T;
  error?: { code: string; message: string };
}

function assertEnvelope<T>(
  value: Envelope<T>,
  command: string,
  code: number | null,
): T {
  assert.equal(code, 0, JSON.stringify(value));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.command, command);
  return value.result as T;
}

test("the JSON envelope covers every read command", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const version = await harness.json<Envelope<{ version: string }>>([
    "version",
    "--json=envelope",
  ]);
  assertEnvelope(version.value, "version", version.code);
  assert.equal(typeof version.value.result?.version, "string");

  const help = await harness.json<Envelope<{ topic: string; help: string }>>([
    "help",
    "list",
    "--json=envelope",
  ]);
  const helpResult = assertEnvelope(help.value, "help", help.code);
  assert.equal(helpResult.topic, "list");
  assert.match(helpResult.help, /hlao list/);

  const commands: { args: string[]; command: string }[] = [
    { args: ["list"], command: "list" },
    { args: ["agents"], command: "agents" },
    { args: ["whoami"], command: "whoami" },
    { args: ["config", "show"], command: "config" },
    { args: ["status", "--start"], command: "status" },
    { args: ["doctor"], command: "doctor" },
    { args: ["logs"], command: "logs" },
    { args: ["find", "nothing-matches"], command: "find" },
    { args: ["down", "--dry-run"], command: "down" },
  ];
  for (const entry of commands) {
    const result = await harness.json<Envelope>([
      ...entry.args,
      "--json=envelope",
    ]);
    if (entry.command === "doctor") {
      // Health probes may legitimately report a warning; the envelope still
      // has to be well formed.
      assert.equal(result.value.command, "doctor");
      assert.equal(result.value.ok, true);
      continue;
    }
    assertEnvelope(result.value, entry.command, result.code);
  }
});

test("the JSON envelope covers mutations and errors", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<Envelope<SpawnValue>>([
    "spawn",
    "fake",
    "hello",
    "--wait",
    "--json=envelope",
  ]);
  const spawnedResult = assertEnvelope(
    spawned.value,
    "spawn",
    spawned.code,
  );
  const id = spawnedResult.session.id;

  for (const entry of [
    { args: ["send", id, "again", "--wait"], command: "send" },
    { args: ["get", id], command: "get" },
    { args: ["read", id], command: "read" },
    { args: ["queue", id], command: "queue" },
    { args: ["rename", id, "renamed"], command: "rename" },
    { args: ["policy", id, "ask"], command: "policy" },
    { args: ["find", "hello"], command: "find" },
    { args: ["cancel", id], command: "cancel" },
    { args: ["close", id], command: "close" },
  ]) {
    const result = await harness.json<Envelope>([
      ...entry.args,
      "--json=envelope",
    ]);
    assertEnvelope(result.value, entry.command, result.code);
  }

  const missing = await harness.json<Envelope>([
    "get",
    "zzzzzz",
    "--json=envelope",
  ]);
  assert.equal(missing.code, 1);
  assert.equal(missing.value.ok, false);
  assert.equal(missing.value.command, "get");
  assert.equal(missing.value.error?.code, "not_found");

  // The default shape stays unchanged.
  const plain = await harness.json<Record<string, unknown>>(["list"]);
  assert.equal(plain.value.ok, undefined);
  assert.ok(Array.isArray(plain.value.sessions));
});
