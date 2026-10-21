import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type SpawnValue,
} from "./harness.js";

type ModesValue = {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
};
type SetModeValue = { session: SpawnValue["session"] };

test("provider modes are advertised, switchable, and validated", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--mode",
    "auto",
  ]);
  assert.equal(spawned.code, 0, JSON.stringify(spawned.value));
  assert.equal(spawned.value.session.modes?.currentModeId, "auto");
  const id = spawned.value.session.id;

  const read = await harness.json<ModesValue>(["mode", id]);
  assert.equal(read.code, 0);
  assert.equal(read.value.currentModeId, "auto");
  assert.deepEqual(
    read.value.availableModes.map((mode) => mode.id),
    ["default", "auto", "bypassPermissions"],
  );

  const changed = await harness.json<SetModeValue>(["mode", id, "default"]);
  assert.equal(changed.code, 0);
  assert.equal(changed.value.session.modes?.currentModeId, "default");

  const bad = await harness.json<JsonError>(["mode", id, "not-a-mode"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.value.error.code, "bad_option");

  const after = await harness.json<ModesValue>(["mode", id]);
  assert.equal(after.value.currentModeId, "default");
});

test("a backend defaultMode applies to operator and agent spawns", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  harness.updateConfig((config) => {
    const backends = config.backends as Record<string, Record<string, unknown>>;
    backends.fake!.defaultMode = "auto";
  });

  const parent = await harness.json<SpawnValue>(["spawn", "fake", "--wait"]);
  assert.equal(parent.code, 0, JSON.stringify(parent.value));
  assert.equal(parent.value.session.modes?.currentModeId, "auto");

  // An agent-spawned child uses the backend default; it cannot choose a mode.
  const child = await harness.json<SpawnValue>(["spawn", "fake", "--wait"], {
    env: { HLAO_SESSION_ID: parent.value.session.id },
  });
  assert.equal(child.code, 0, JSON.stringify(child.value));
  assert.equal(child.value.session.modes?.currentModeId, "auto");

  // Reads stay open to the agent.
  const read = await harness.json<ModesValue>(["mode", child.value.session.id], {
    env: { HLAO_SESSION_ID: child.value.session.id },
  });
  assert.equal(read.code, 0);
  assert.equal(read.value.currentModeId, "auto");

  const listed = await harness.json<{
    agents: { name: string; defaultMode?: string }[];
  }>(["agents"]);
  assert.equal(
    listed.value.agents.find((agent) => agent.name === "fake")?.defaultMode,
    "auto",
  );
});

test("an operator --mode overrides the backend defaultMode", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  harness.updateConfig((config) => {
    const backends = config.backends as Record<string, Record<string, unknown>>;
    backends.fake!.defaultMode = "auto";
  });

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--mode",
    "default",
    "--wait",
  ]);
  assert.equal(spawned.code, 0, JSON.stringify(spawned.value));
  assert.equal(spawned.value.session.modes?.currentModeId, "default");
});

test("an invalid defaultMode is the adapter's error at spawn", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  harness.updateConfig((config) => {
    const backends = config.backends as Record<string, Record<string, unknown>>;
    backends.fake!.defaultMode = "not-a-mode";
  });

  const spawned = await harness.json<JsonError>(["spawn", "fake"]);
  assert.equal(spawned.code, 1);
  assert.equal(spawned.value.error.code, "bad_option");
});

test("a mode config option is operator-only on every path", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await harness.json<SpawnValue>(["spawn", "fake", "--wait"]);
  assert.equal(parent.code, 0);
  const parentId = parent.value.session.id;
  const agentEnv = { HLAO_SESSION_ID: parentId };

  // spawn --config mode=... is a mode set, not an ordinary config option.
  const before = await harness.json<{ sessions: unknown[] }>(["list", "--all"]);
  const viaSpawn = await harness.json<JsonError>(
    ["spawn", "fake", "--config", "mode=bypassPermissions", "--wait"],
    { env: agentEnv },
  );
  assert.equal(viaSpawn.code, 1);
  assert.equal(viaSpawn.value.error.code, "operator_only");
  const after = await harness.json<{ sessions: unknown[] }>(["list", "--all"]);
  assert.equal(after.value.sessions.length, before.value.sessions.length);

  // option <id> mode ... is the same control.
  const child = await harness.json<SpawnValue>(["spawn", "fake", "--wait"], {
    env: agentEnv,
  });
  assert.equal(child.code, 0);
  const childId = child.value.session.id;
  assert.equal(child.value.session.modes?.currentModeId, "default");

  const viaOption = await harness.json<JsonError>(
    ["option", childId, "mode", "bypassPermissions"],
    { env: agentEnv },
  );
  assert.equal(viaOption.code, 1);
  assert.equal(viaOption.value.error.code, "operator_only");

  const unchanged = await harness.json<ModesValue>(["mode", childId]);
  assert.equal(unchanged.value.currentModeId, "default");

  // The operator still has both paths.
  const operatorOption = await harness.json<SetModeValue>([
    "option",
    childId,
    "mode",
    "auto",
  ]);
  assert.equal(operatorOption.code, 0);
  assert.equal(operatorOption.value.session.modes?.currentModeId, "auto");

  const operatorSpawn = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--config",
    "mode=auto",
    "--wait",
  ]);
  assert.equal(operatorSpawn.code, 0);
  assert.equal(operatorSpawn.value.session.modes?.currentModeId, "auto");
});

test("mode bulk selectors replace policy bulk and are operator-only", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await harness.json<SpawnValue>(["spawn", "fake", "--wait"]);
  assert.equal(parent.code, 0);
  const parentId = parent.value.session.id;
  const child = await harness.json<SpawnValue>(["spawn", "fake", "--wait"], {
    env: { HLAO_SESSION_ID: parentId },
  });
  assert.equal(child.code, 0);
  const childId = child.value.session.id;

  const changed = await harness.json<{
    count: number;
    sessions: { id: string; modes: { currentModeId: string } | null }[];
  }>(["mode", "--root", parentId, "auto"]);
  assert.equal(changed.code, 0, JSON.stringify(changed.value));
  assert.equal(changed.value.count, 2);
  assert.deepEqual(
    new Set(changed.value.sessions.map((session) => session.id)),
    new Set([parentId, childId]),
  );
  assert.ok(
    changed.value.sessions.every(
      (session) => session.modes?.currentModeId === "auto",
    ),
  );

  const refused = await harness.json<JsonError>(
    ["mode", "--root", parentId, "default"],
    { env: { HLAO_SESSION_ID: childId } },
  );
  assert.equal(refused.code, 1);
  assert.equal(refused.value.error.code, "operator_only");
});
