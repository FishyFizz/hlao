import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAKE_BACKEND,
  Harness,
  type DoctorValue,
  type JsonError,
} from "./harness.js";

test("invalid user config fails startup instead of creating an empty instance", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  harness.writeConfig({ waitTime: 1000 });

  const spawned = await harness.json<JsonError>(["spawn", "fake"]);
  assert.equal(spawned.code, 1);
  assert.equal(spawned.value.error.code, "config_invalid");
  assert.match(spawned.value.error.message, /unknown field "waitTime"/);

  // The first command a user runs must report the config failure, not an
  // empty instance with exit 0.
  const listed = await harness.json<JsonError>(["list"]);
  assert.equal(listed.code, 1);
  assert.equal(listed.value.error.code, "config_invalid");
  assert.match(listed.value.error.message, /config\.json/);
  assert.equal(
    (listed.value.error.message.match(/config\.json/g) ?? []).length,
    1,
    "the config path is named once",
  );

  const agents = await harness.json<JsonError>(["agents"]);
  assert.equal(agents.code, 1);
  assert.equal(agents.value.error.code, "config_invalid");

  const started = await harness.json<JsonError>(["status", "--start"]);
  assert.equal(started.code, 1);
  assert.equal(started.value.error.code, "config_invalid");

  // Doctor inspects locally and fails without starting a supervisor.
  const doctor = await harness.json<DoctorValue>(["doctor"]);
  assert.equal(doctor.code, 1);
  assert.equal(doctor.value.ok, false);
  assert.ok(
    doctor.value.checks.some(
      (check) => check.name === "config" && check.status === "fail",
    ),
  );
  assert.ok(
    doctor.value.checks.some(
      (check) => check.name === "backends" && check.status === "fail",
    ),
  );
});

test("permissionPolicy is rejected with a defaultMode migration message", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  harness.writeConfig({
    permissionPolicy: "allow",
    backends: { fake: FAKE_BACKEND },
  });

  const validate = await harness.json<JsonError>(["config", "validate"]);
  assert.equal(validate.code, 1);
  assert.equal(validate.value.error.code, "config_invalid");
  assert.match(validate.value.error.message, /permissionPolicy/);
  assert.match(validate.value.error.message, /defaultMode/);

  const spawned = await harness.json<JsonError>(["spawn", "fake"]);
  assert.equal(spawned.code, 1);
  assert.equal(spawned.value.error.code, "config_invalid");
  assert.match(spawned.value.error.message, /defaultMode/);
});

test("--permission and the policy command fail with migration messages", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const permission = await harness.json<JsonError>([
    "spawn",
    "fake",
    "--permission",
    "ask",
  ]);
  assert.equal(permission.code, 1);
  assert.equal(permission.value.error.code, "bad_request");
  assert.match(permission.value.error.message, /--permission was removed/);
  assert.match(permission.value.error.message, /defaultMode/);

  const policy = await harness.json<JsonError>(["policy", "any", "allow"]);
  assert.equal(policy.code, 1);
  assert.equal(policy.value.error.code, "bad_request");
  assert.match(policy.value.error.message, /"hlao policy" was removed/);
  assert.match(policy.value.error.message, /hlao mode/);
});
